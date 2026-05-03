"use client";

/**
 * Wires the @signchat/runtime-browser pluggable hooks (logger + latency
 * mark) to the web app's LogBus + LatencyStore. Imported by the room
 * shell once at first render so any subsequent runtime-browser module
 * call lands in the right sinks.
 *
 * Side-effect-only: no exports.
 */

import { setRuntimeLogger } from "@signchat/runtime-browser/logger";
import { setMarkFn } from "@signchat/runtime-browser/diagnostics/mark";
import { LogBus } from "./log-bus";
import { mark as latencyMark } from "./latency-markers";

let installed = false;

export function installRuntimeBridge(): void {
  if (installed) return;
  installed = true;
  setRuntimeLogger({
    debug: (scope, message, meta) => LogBus.debug(scope, message, meta),
    info: (scope, message, meta) => LogBus.info(scope, message, meta),
    warn: (scope, message, meta) => LogBus.warn(scope, message, meta),
    error: (scope, message, meta) => LogBus.error(scope, message, meta),
  });
  setMarkFn(latencyMark);
}

// Eagerly install on first import. Modules that re-import this just see the
// idempotent guard.
installRuntimeBridge();
