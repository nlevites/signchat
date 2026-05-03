import { log } from "../logger";
import { fetchModelCached } from "./model-cache";

/**
 * onnxruntime-web session loader for the 250-class asl-signs classifier.
 *
 * onnxruntime-web is CDN-loaded via the `new Function("u", "return import(u)")`
 * shim per ARCHITECTURE.md §5.4 — the package is intentionally NOT in
 * package.json so Turbopack doesn't try to bundle the WASM glue. Types here
 * are structural so we don't need a build-time dep either.
 *
 * Execution provider: WASM only. WebGPU was empirically ~1000x slower for
 * this Squeezeformer + dynamic-time-dim workload (architecture note).
 */

// ===== ort version pin =======================================================

const ORT_VERSION = "1.20.1";
const ORT_CDN_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.mjs`;
const ORT_WASM_PATHS = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

// ===== structural types ======================================================

export type OrtTensorType = "float32" | "int64" | "int32" | "uint8" | "bool";

export interface OrtTensor {
  readonly type: OrtTensorType;
  readonly data: Float32Array | BigInt64Array | Int32Array | Uint8Array | Uint8ClampedArray;
  readonly dims: ReadonlyArray<number>;
}

export interface OrtTensorConstructor {
  new (type: OrtTensorType, data: Float32Array, dims: ReadonlyArray<number>): OrtTensor;
}

export interface OrtInferenceSession {
  readonly inputNames: ReadonlyArray<string>;
  readonly outputNames: ReadonlyArray<string>;
  run(
    feeds: Record<string, OrtTensor>,
    options?: { logSeverityLevel?: number },
  ): Promise<Record<string, OrtTensor>>;
  release?(): Promise<void>;
}

export interface OrtModule {
  Tensor: OrtTensorConstructor;
  InferenceSession: {
    create(
      modelUrlOrBuffer: string | ArrayBuffer | Uint8Array,
      options?: {
        executionProviders?: ReadonlyArray<string | { name: string; [k: string]: unknown }>;
        graphOptimizationLevel?: "disabled" | "basic" | "extended" | "all";
        logSeverityLevel?: number;
      },
    ): Promise<OrtInferenceSession>;
  };
  env: {
    wasm: {
      wasmPaths?: string;
      numThreads?: number;
      simd?: boolean;
    };
    logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
  };
}

// ===== CDN loader ============================================================

let ortPromise: Promise<OrtModule> | null = null;

/**
 * Load `onnxruntime-web` over CDN once, return the cached module.
 *
 * The `new Function("u", "return import(u)")` shim hides the dynamic import
 * from Turbopack so it doesn't try to bundle ort. Subsequent calls reuse the
 * same Promise.
 */
export async function loadOrt(): Promise<OrtModule> {
  if (ortPromise) return ortPromise;
  if (typeof window === "undefined") {
    throw new Error("loadOrt() called outside the browser; use onnxruntime-node for Node");
  }
  log.info("ort", `loading onnxruntime-web@${ORT_VERSION} from CDN`);
  const dynamicImport = new Function("u", "return import(u)") as (
    u: string,
  ) => Promise<unknown>;
  ortPromise = dynamicImport(ORT_CDN_URL).then((mod) => {
    const ort = mod as OrtModule;
    ort.env.wasm.wasmPaths = ORT_WASM_PATHS;
    log.info("ort", "onnxruntime-web ready", {
      wasmPaths: ort.env.wasm.wasmPaths,
    });
    return ort;
  });
  return ortPromise;
}

// ===== session factory =======================================================

export interface CreateSessionOptions {
  /** Where the .onnx file lives. Defaults to /models/asl-signs/asl-signs.onnx. */
  modelUrl?: string;
  /** Override execution providers. Default: ["wasm"]. */
  executionProviders?: ReadonlyArray<string>;
}

export const ASL_MODEL_URL = "/models/asl-signs/asl-signs.onnx";

/**
 * Fetch the .onnx bytes preferring the IndexedDB cache (Phase 5c). Falls
 * back to network on cache miss + writes the bytes back. Optional progress
 * callback fires for both paths so the UI can render a unified bar.
 */
export async function fetchModelBuffer(
  url: string = ASL_MODEL_URL,
  onProgress?: (received: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const result = await fetchModelCached(url, {
    ...(onProgress ? { onProgress } : {}),
  });
  return result.bytes;
}

/**
 * High-level helper: load ort, fetch the model, create a session.
 *
 * Caller supplies optional progress callback for the model download UI.
 */
export async function createAslSession(
  options: CreateSessionOptions & {
    onProgress?: (received: number, total: number | null) => void;
  } = {},
): Promise<OrtInferenceSession> {
  const ort = await loadOrt();
  const url = options.modelUrl ?? ASL_MODEL_URL;
  log.info("ort", `fetching ${url}`);
  const buffer = await fetchModelBuffer(url, options.onProgress);
  log.info("ort", `creating InferenceSession (${buffer.byteLength} bytes)`);
  const session = await ort.InferenceSession.create(buffer, {
    executionProviders: options.executionProviders ?? ["wasm"],
    graphOptimizationLevel: "all",
  });
  log.info("ort", "session ready", {
    inputs: session.inputNames,
    outputs: session.outputNames,
  });
  return session;
}

/**
 * Build a Float32 input Tensor for a (T, 543, 3) landmark window.
 * `flat` must be of length T*543*3 in row-major order.
 */
export async function makeLandmarkTensor(
  flat: Float32Array,
  T: number,
): Promise<OrtTensor> {
  if (flat.length !== T * 543 * 3) {
    throw new Error(
      `landmark tensor length mismatch: got ${flat.length}, expected ${T * 543 * 3}`,
    );
  }
  const ort = await loadOrt();
  return new ort.Tensor("float32", flat, [T, 543, 3]);
}
