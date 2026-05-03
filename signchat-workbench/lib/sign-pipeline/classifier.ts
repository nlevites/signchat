import type { SignToken } from "@/lib/contracts";

/**
 * One classification tick from a Classifier impl. The mode controller (Phase 5a)
 * consumes top-K results to drive its admit logic; SignToken's `via` field is
 * stamped by the buffer when admitting, not by the classifier itself.
 *
 * `top` is sorted descending by `score`. Length defaults to 3 across impls.
 */
export interface ClassifierResult {
  /** performance.now() at the moment the inference window completed. */
  ts: number;
  /** Top-K predictions, descending by softmax score. */
  top: ReadonlyArray<{ label: string; score: number }>;
}

export type ClassifierState = "idle" | "starting" | "running" | "error" | "stopped";

/**
 * Source-agnostic interface that the Sign capture pane (and the end-to-end
 * pane) consume. Two impls planned:
 *   - ScriptedClassifier      — Phase 5a, replays a hand-authored timeline
 *   - MediaPipeOnnxClassifier — Phase 5b, real camera + MediaPipe + ONNX
 *
 * Both produce ClassifierResult; only the mode controller's buffer turns those
 * into admitted {@link SignToken}s.
 */
export interface Classifier {
  /**
   * Boot the classifier. Idempotent. Safe to call after stop(). Throws on
   * fatal init errors (camera permission denied, model 404, etc.).
   */
  start(): Promise<void>;
  /**
   * Halt inference + release resources. Idempotent. Safe to call from React
   * cleanup paths.
   */
  stop(): Promise<void>;
  /** Subscribe to per-window predictions. Returns an unsubscribe handle. */
  onResult(cb: (result: ClassifierResult) => void): () => void;
  /** Subscribe to lifecycle state transitions. Returns an unsubscribe handle. */
  onStateChange(cb: (state: ClassifierState, error?: Error) => void): () => void;
  /** Current state. */
  state(): ClassifierState;
}

// Re-export SignToken from contracts so call sites can import a single module.
export type { SignToken };
