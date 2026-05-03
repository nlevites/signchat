"use client";

// transformers.js is loaded via a `new Function('u', 'return import(u);')` shim
// from esm.sh — never bundled. Same pattern as onnxruntime-web per claude.md.
// turbopack cannot parse the package's prebundled UMD chunk-loader, and the
// package's ESM build references node built-ins (`import * from "fs"`) the
// browser can't resolve. esm.sh shims those out so the import succeeds.

export interface PrewarmProgress {
  status: string;
  file?: string;
  progress?: number;
  loaded?: number;
  total?: number;
}

const TRANSFORMERS_CDN = "https://esm.sh/@huggingface/transformers@3.0.2";

interface OrtEnv {
  logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
}

interface TransformersModule {
  pipeline: (
    task: "automatic-speech-recognition",
    model: string,
    opts?: {
      device?: "webgpu" | "wasm";
      dtype?: "fp32" | "fp16" | "q8" | "q4";
      progress_callback?: (p: PrewarmProgress) => void;
    },
  ) => Promise<unknown>;
  env: {
    allowLocalModels: boolean;
    backends?: { onnx?: OrtEnv };
  };
}

// ORT's WASM binary bakes in its log-severity threshold during _OrtCreateSession,
// so env.logLevel = "error" set from js doesn't take effect in time. these
// "VerifyEachNodeIsAssignedToAnEp" warnings just say shape-related ops fall back
// to CPU on the WebGPU EP, which is expected for whisper — pure noise.
//
// emscripten's printErr (which ort uses for ORT_LOG) routes to console.error
// regardless of the embedded "[W:" severity tag, so we have to filter both
// console.error AND console.warn. our wrap installs before the model loads
// and shadows next.js's browser-log bridge so they never reach the terminal.
let consolePatched = false;
function silenceOrtNoise(): void {
  if (consolePatched || typeof window === "undefined") return;
  consolePatched = true;
  const isOrtNoise = (args: unknown[]): boolean => {
    const first = args[0];
    return (
      typeof first === "string" &&
      first.includes("[W:onnxruntime") &&
      first.includes("VerifyEachNodeIsAssignedToAnEp")
    );
  };
  const origWarn = console.warn.bind(console);
  const origError = console.error.bind(console);
  console.warn = (...args: unknown[]) => {
    if (isOrtNoise(args)) return;
    origWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    if (isOrtNoise(args)) return;
    origError(...args);
  };
}

let modulePromise: Promise<TransformersModule> | null = null;

function loadModule(): Promise<TransformersModule> {
  if (!modulePromise) {
    silenceOrtNoise();
    const dynamicImport = new Function("u", "return import(u);") as (
      u: string,
    ) => Promise<TransformersModule>;
    modulePromise = dynamicImport(TRANSFORMERS_CDN).then((m) => {
      m.env.allowLocalModels = false;
      const ortEnv = m.env.backends?.onnx;
      if (ortEnv) ortEnv.logLevel = "error";
      return m;
    });
  }
  return modulePromise;
}

export async function prewarmWhisper(
  modelId: string,
  onProgress: (p: PrewarmProgress) => void,
): Promise<void> {
  const mod = await loadModule();
  const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
  const device: "webgpu" | "wasm" = hasWebGPU ? "webgpu" : "wasm";
  await mod.pipeline("automatic-speech-recognition", modelId, {
    device,
    dtype: device === "webgpu" ? "fp32" : "q8",
    progress_callback: onProgress,
  });
}

const SILERO_VAD_URL =
  "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx";

export async function prewarmVad(): Promise<void> {
  const res = await fetch(SILERO_VAD_URL, { cache: "force-cache" });
  if (!res.ok) throw new Error(`silero vad fetch failed: ${res.status}`);
  await res.arrayBuffer();
}
