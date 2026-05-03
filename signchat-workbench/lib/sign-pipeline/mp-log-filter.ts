"use client";

/**
 * MediaPipe Tasks Vision routes its internal INFO and W (warning) logs
 * through `console.error` (Emscripten printErr). Next.js dev mode treats
 * every `console.error` as a Console Error and surfaces it via the issue
 * overlay — extremely noisy for known-benign messages like:
 *
 *   "INFO: Created TensorFlow Lite XNNPACK delegate for CPU."
 *   "W0503 03:23:19.546000 ... OpenGL error checking is disabled"
 *   "I0503 03:23:19.545000 ... GL version: 3.0 ..."
 *
 * This module installs a one-shot filter that downgrades these specific
 * messages to `console.debug`. Real errors keep flowing through normally.
 *
 * Intended to be installed once at MediaPipe boot time and never removed —
 * the noise comes from the wasm module's lifetime, not just init.
 */

let installed = false;

const NOISE_PATTERNS: readonly RegExp[] = [
  /^INFO: Created TensorFlow Lite/,
  /^I\d{4} \d{2}:\d{2}:\d{2}\.\d+ \d+ /, // glog INFO format
  /^W\d{4} \d{2}:\d{2}:\d{2}\.\d+ \d+ /, // glog WARN format
];

function isMediaPipeNoise(args: ReadonlyArray<unknown>): boolean {
  if (args.length === 0) return false;
  const first = args[0];
  if (typeof first !== "string") return false;
  for (const re of NOISE_PATTERNS) {
    if (re.test(first)) return true;
  }
  return false;
}

/**
 * Safe to call multiple times; only installs once. No-op outside the browser.
 */
export function installMediaPipeLogFilter(): void {
  if (installed) return;
  if (typeof window === "undefined" || typeof console === "undefined") return;
  installed = true;
  const origError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    if (isMediaPipeNoise(args)) {
      console.debug(...args);
      return;
    }
    origError(...args);
  };
}
