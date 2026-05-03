/**
 * Pluggable logger for runtime-browser.
 *
 * Modules in this package never import a host-app log sink directly; they
 * call `log.foo(scope, message, meta)`. Each app wires its own implementation
 * once at startup via `setRuntimeLogger(...)` (apps/web wires it to LogBus,
 * apps/bridge wires it to a console + ring buffer).
 *
 * The default sink is a thin `console.*` wrapper so calls before `setRuntimeLogger`
 * still go somewhere visible during early boot.
 */

export interface RuntimeLogger {
  debug(scope: string, message: string, meta?: unknown): void;
  info(scope: string, message: string, meta?: unknown): void;
  warn(scope: string, message: string, meta?: unknown): void;
  error(scope: string, message: string, meta?: unknown): void;
}

const consoleLogger: RuntimeLogger = {
  debug: (scope, message, meta) =>
    typeof console !== "undefined"
      ? console.debug(`[${scope}] ${message}`, meta ?? "")
      : undefined,
  info: (scope, message, meta) =>
    typeof console !== "undefined"
      ? console.info(`[${scope}] ${message}`, meta ?? "")
      : undefined,
  warn: (scope, message, meta) =>
    typeof console !== "undefined"
      ? console.warn(`[${scope}] ${message}`, meta ?? "")
      : undefined,
  error: (scope, message, meta) =>
    typeof console !== "undefined"
      ? console.error(`[${scope}] ${message}`, meta ?? "")
      : undefined,
};

let activeLogger: RuntimeLogger = consoleLogger;

export function setRuntimeLogger(logger: RuntimeLogger): void {
  activeLogger = logger;
}

export function getRuntimeLogger(): RuntimeLogger {
  return activeLogger;
}

/**
 * Stable proxy that always delegates to the currently-active logger so
 * modules can `import { log } from "../logger"` once and never rebind.
 */
export const log: RuntimeLogger = {
  debug: (scope, message, meta) => activeLogger.debug(scope, message, meta),
  info: (scope, message, meta) => activeLogger.info(scope, message, meta),
  warn: (scope, message, meta) => activeLogger.warn(scope, message, meta),
  error: (scope, message, meta) => activeLogger.error(scope, message, meta),
};
