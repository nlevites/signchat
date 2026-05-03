export interface OnnxInferenceSessionLike {
  run(feeds: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface OnnxRuntimeLike {
  InferenceSession: {
    create(
      modelUrl: string,
      options?: { executionProviders?: Array<"wasm" | "webgpu" | "cpu"> },
    ): Promise<OnnxInferenceSessionLike>;
  };
}

const ONNX_CDN_URL =
  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/ort.min.mjs";

// eslint-disable-next-line no-new-func
const dynamicImport = new Function("u", "return import(u)") as (
  url: string,
) => Promise<unknown>;

let cached: OnnxRuntimeLike | null = null;

export async function loadOnnxRuntime(): Promise<OnnxRuntimeLike> {
  if (cached) return cached;
  const mod = await dynamicImport(ONNX_CDN_URL);
  cached = mod as OnnxRuntimeLike;
  return cached;
}

export async function loadAslSignsSession(
  runtime: OnnxRuntimeLike,
  modelUrl: string,
): Promise<OnnxInferenceSessionLike> {
  return runtime.InferenceSession.create(modelUrl, {
    executionProviders: ["wasm"],
  });
}
