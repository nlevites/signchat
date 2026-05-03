import { setRuntimeLogger } from "@signchat/runtime-browser/logger";

/**
 * Wires runtime-browser's pluggable logger to a console + ring-buffer sink
 * so the (future) debug pane can render Bridge's logs the same way the
 * web app's LogStream does.
 *
 * Side-effect-only; imported once from main.tsx before <App/> renders.
 */

interface BridgeLogEntry {
  id: number;
  ts: number;
  scope: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: unknown;
}

const RING_SIZE = 1000;
let nextId = 1;
const ring: BridgeLogEntry[] = [];

function push(entry: BridgeLogEntry): void {
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
}

function emit(level: BridgeLogEntry["level"]) {
  return (scope: string, message: string, meta?: unknown) => {
    const entry: BridgeLogEntry = {
      id: nextId++,
      ts: Date.now(),
      scope,
      level,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };
    push(entry);
    const fn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : level === "debug"
            ? console.debug
            : console.info;
    fn.call(console, `[${scope}] ${message}`, meta ?? "");
  };
}

setRuntimeLogger({
  debug: emit("debug"),
  info: emit("info"),
  warn: emit("warn"),
  error: emit("error"),
});

/** Snapshot of the in-memory ring; stable until next emit. */
export function getBridgeLogSnapshot(): readonly BridgeLogEntry[] {
  return ring.slice();
}
