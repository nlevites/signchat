/**
 * Pure §9 mode controller. Owns the FSM, the SignBuffer, the §9.3 admit
 * logic, and the Auto confidence-streak detection. No React, no DOM, no
 * SDK calls — the pane wires async work (OpenRouter, ElevenLabs, LiveKit
 * publish) on top of the controller's state transitions and notifies the
 * controller of results via `setReconstruction`, `speakingDone`, etc.
 *
 * Single-shot per pane: `createModeController()` returns a fresh
 * controller; the pane disposes it on unmount via the returned `dispose`
 * method. State changes notify subscribers synchronously; subscribers
 * should call `snapshot()` to read the immutable view.
 *
 * Auto-mode transitions are confidence-driven (no manual button needed):
 *   - idle → capturing: top1.score ≥ autoStartThreshold on a single tick
 *   - capturing → stitching: top1.score < autoStopThreshold sustained for
 *     silenceMs (or → idle if buffer is empty when the streak completes)
 *   - stitching → speaking: setReconstruction auto-approves (no preview UX)
 *
 * Manual mode keeps the explicit Start/Stop buttons and the
 * Preview/Approve/Edit/Re-sign/Discard UX.
 */

import {
  DEFAULT_AUTO_THRESHOLDS,
  type AutoThresholds,
  type CaptureMode,
  type ModeState,
  type ReconstructionPayload,
  type SignBuffer,
  type SignToken,
} from "@signchat/contracts";
import { STABILITY_TICKS } from "@signchat/sign-pipeline";
import { LogBus } from "@/lib/diagnostics/log-bus";
import type { ClassifierResult } from "@/lib/sign-pipeline/classifier";

export interface ModeControllerOptions {
  thresholds?: AutoThresholds;
  mode?: CaptureMode;
}

export interface ModeSnapshot {
  state: ModeState;
  mode: CaptureMode;
  buffer: SignBuffer;
  thresholds: AutoThresholds;
  /** Set when state === "preview"; the parsed payload from OpenRouter. */
  preview: ReconstructionPayload | null;
  /** Set when state === "speaking"; the (possibly edited) sentence. */
  speakingSentence: string | null;
  /** Last user-facing error message, if any. Cleared on next `start()`. */
  error: string | null;
  /** Wall-clock ms when the current state was entered. */
  enteredStateAt: number;
  /**
   * Wall-clock ms when the current sub-autoStopThreshold streak began. Null
   * when not in a streak (i.e., classifier confidence is above the floor).
   * The Auto silence countdown UI reads this; when null, no countdown shows.
   */
  lowConfidenceStartedAt: number | null;
}

export interface ModeController {
  // intent
  setMode(mode: CaptureMode): void;
  setThresholds(t: AutoThresholds): void;
  start(): void;
  stopManual(): void;
  cancel(): void;
  resign(): void;
  discard(): void;
  approve(text: string): void;
  // events from outside
  ingest(result: ClassifierResult): void;
  setReconstruction(payload: ReconstructionPayload): void;
  setLLMError(message: string): void;
  speakingDone(): void;
  speakingError(message: string): void;
  // observability
  subscribe(cb: () => void): () => void;
  snapshot(): ModeSnapshot;
  /** Latest buffer epoch — async consumers compare against this on resolve. */
  epoch(): number;
  /** Drop subscribers. Call from unmount. */
  dispose(): void;
}

const EMPTY_BUFFER: SignBuffer = Object.freeze({
  tokens: [],
  startedAt: 0,
  lastAdmitAt: null,
  epoch: 0,
}) as SignBuffer;

export function createModeController(
  opts: ModeControllerOptions = {},
): ModeController {
  let state: ModeState = "idle";
  let mode: CaptureMode = opts.mode ?? "auto";
  let thresholds: AutoThresholds = { ...(opts.thresholds ?? DEFAULT_AUTO_THRESHOLDS) };
  let buffer: SignBuffer = EMPTY_BUFFER;
  let preview: ReconstructionPayload | null = null;
  let speakingSentence: string | null = null;
  let error: string | null = null;
  let enteredStateAt: number = Date.now();
  let lowConfidenceStartedAt: number | null = null;
  let cachedSnapshot: ModeSnapshot = buildSnapshot();

  // Admit-logic memory.
  let lastTickTop1: { label: string; score: number } | null = null;
  let lastAdmitLabel: string | null = null;
  let stitchEpoch = 0;
  const subscribers = new Set<() => void>();

  function buildSnapshot(): ModeSnapshot {
    return {
      state,
      mode,
      buffer,
      thresholds,
      preview,
      speakingSentence,
      error,
      enteredStateAt,
      lowConfidenceStartedAt,
    };
  }

  function notify(): void {
    cachedSnapshot = buildSnapshot();
    for (const cb of subscribers) {
      try {
        cb();
      } catch {
        // ignore subscriber faults
      }
    }
  }

  function transition(next: ModeState): void {
    state = next;
    enteredStateAt = Date.now();
    lowConfidenceStartedAt = null;
  }

  function startBuffer(): void {
    buffer = {
      tokens: [],
      startedAt: Date.now(),
      lastAdmitAt: null,
      epoch: buffer.epoch + 1,
    };
    lastTickTop1 = null;
    lastAdmitLabel = null;
  }

  function admit(token: SignToken): void {
    buffer = {
      ...buffer,
      tokens: [...buffer.tokens, token],
      lastAdmitAt: token.ts,
    };
    lastAdmitLabel = token.label;
  }

  return {
    setMode(next: CaptureMode): void {
      if (next === mode) return;
      mode = next;
      // Switching to manual mid-capture clears the auto silence streak so
      // the explicit Stop button is the only way out.
      if (next === "manual") lowConfidenceStartedAt = null;
      notify();
    },
    setThresholds(next: AutoThresholds): void {
      thresholds = { ...next };
      notify();
    },
    start(): void {
      // Allow Idle → Capturing only. Other states should call cancel/discard
      // first.
      if (state !== "idle") return;
      error = null;
      preview = null;
      speakingSentence = null;
      startBuffer();
      transition("capturing");
      notify();
    },
    stopManual(): void {
      if (state !== "capturing") return;
      if (buffer.tokens.length === 0) return; // nothing to stitch
      stitchEpoch += 1;
      transition("stitching");
      notify();
    },
    cancel(): void {
      if (state !== "capturing") return;
      buffer = EMPTY_BUFFER;
      stitchEpoch += 1;
      transition("idle");
      notify();
    },
    resign(): void {
      if (state !== "preview") return;
      preview = null;
      startBuffer();
      transition("capturing");
      notify();
    },
    discard(): void {
      if (state !== "preview") return;
      preview = null;
      buffer = EMPTY_BUFFER;
      stitchEpoch += 1;
      transition("idle");
      notify();
    },
    approve(text: string): void {
      if (state !== "preview") return;
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      speakingSentence = trimmed;
      preview = null;
      transition("speaking");
      notify();
    },
    ingest(result: ClassifierResult): void {
      if (result.top.length === 0) return;
      const top1 = result.top[0]!;
      const top2 = result.top[1] ?? null;

      // ---- Auto-start: idle → capturing on a high-confidence tick. ----
      if (
        state === "idle" &&
        mode === "auto" &&
        top1.score >= thresholds.autoStartThreshold
      ) {
        LogBus.debug("mode-controller", "auto-start", {
          label: top1.label,
          score: top1.score,
          autoStartThreshold: thresholds.autoStartThreshold,
        });
        error = null;
        preview = null;
        speakingSentence = null;
        startBuffer();
        transition("capturing");
        // fall through so this tick is also fed to the admit logic below;
        // it seeds lastTickTop1 so a subsequent tick at the same label can
        // satisfy STABILITY_TICKS.
      }

      // The controller only consumes ClassifierResults while capturing
      // (auto-start above may have just transitioned us into it). Stale
      // ticks during stitching/preview/speaking are silently dropped.
      if (state !== "capturing") return;

      // ---- Auto-stop: track the sub-autoStopThreshold streak. ----
      // Only run the streak after at least one admit has landed in this
      // turn. Otherwise the user has just clicked Start (or auto-started
      // on a transient top1 spike) and is preparing to sign — bouncing
      // them back to idle 2s later would be terrible UX. Cancel is still
      // available manually.
      //
      // Use Date.now() (wall-clock) for the streak so the snapshot field
      // shares an axis with enteredStateAt and the CaptureControls
      // countdown chip's nowMs = Date.now(). The classifier's result.ts
      // is performance.now() which is page-load-relative and would put
      // ~1.7e12 ms of error into any UI math against Date.now().
      if (mode === "auto" && buffer.tokens.length > 0) {
        const nowWall = Date.now();
        if (top1.score < thresholds.autoStopThreshold) {
          if (lowConfidenceStartedAt === null) {
            lowConfidenceStartedAt = nowWall;
            LogBus.debug("mode-controller", "low-confidence streak begin", {
              score: top1.score,
              autoStopThreshold: thresholds.autoStopThreshold,
            });
            notify();
          } else if (nowWall - lowConfidenceStartedAt >= thresholds.silenceMs) {
            LogBus.debug("mode-controller", "auto-stop -> stitching", {
              tokens: buffer.tokens.length,
              silenceMs: thresholds.silenceMs,
            });
            lowConfidenceStartedAt = null;
            stitchEpoch += 1;
            transition("stitching");
            notify();
            return;
          }
        } else if (lowConfidenceStartedAt !== null) {
          lowConfidenceStartedAt = null;
          notify();
        }
      } else if (mode === "auto" && lowConfidenceStartedAt !== null) {
        // Buffer drained (e.g., post-stitching reset arrived mid-tick) —
        // clear any in-flight streak so the chip doesn't linger.
        lowConfidenceStartedAt = null;
        notify();
      }

      let admitted: SignToken | null = null;

      // Stable admit (§9.3): top1.score ≥ top1Threshold AND last-tick top1
      // matches; STABILITY_TICKS = 2 fixed (current + previous tick).
      if (
        top1.score >= thresholds.top1Threshold &&
        STABILITY_TICKS === 2 &&
        lastTickTop1 !== null &&
        lastTickTop1.label === top1.label &&
        lastTickTop1.score >= thresholds.top1Threshold
      ) {
        // Avoid duplicate same-label admits (the same label matches across
        // many ticks while the user holds the sign).
        if (lastAdmitLabel !== top1.label) {
          admitted = {
            label: top1.label,
            score: top1.score,
            ts: result.ts,
            via: "stable",
          };
        }
      }

      // Band admit (§9.3): top1 in [top2Threshold, top1Threshold) AND top2
      // ≥ top2Threshold AND not duplicate of last admit.
      if (
        admitted === null &&
        top2 !== null &&
        top1.score >= thresholds.top2Threshold &&
        top1.score < thresholds.top1Threshold &&
        top2.score >= thresholds.top2Threshold &&
        lastAdmitLabel !== top1.label
      ) {
        admitted = {
          label: top1.label,
          score: top1.score,
          ts: result.ts,
          via: "band",
        };
      }

      if (admitted) admit(admitted);
      lastTickTop1 = { label: top1.label, score: top1.score };
      if (admitted) notify();
    },
    setReconstruction(payload: ReconstructionPayload): void {
      // Only accept while in stitching; if a Cancel/Discard fired, the state
      // will already be `idle` and we drop this stale callback.
      if (state !== "stitching") return;
      if (mode === "auto") {
        // Auto mode skips the Preview / Approve UX and ships the LLM's
        // sentence straight to the speaking stage. The DeafSession's
        // approveContextRef must be populated before this call so the
        // §11.4 caption broadcast carries the right confidence/usedSigns.
        const trimmed = payload.sentence.trim();
        if (trimmed.length === 0) {
          // Treat as parse failure rather than ship empty audio.
          error = "LLM returned empty sentence";
          preview = null;
          buffer = EMPTY_BUFFER;
          stitchEpoch += 1;
          transition("idle");
          notify();
          return;
        }
        speakingSentence = trimmed;
        preview = null;
        transition("speaking");
        notify();
        return;
      }
      preview = payload;
      transition("preview");
      notify();
    },
    setLLMError(message: string): void {
      if (state !== "stitching") return;
      error = message;
      preview = null;
      buffer = EMPTY_BUFFER;
      stitchEpoch += 1;
      transition("idle");
      notify();
    },
    speakingDone(): void {
      if (state !== "speaking") return;
      speakingSentence = null;
      buffer = EMPTY_BUFFER;
      transition("idle");
      notify();
    },
    speakingError(message: string): void {
      if (state !== "speaking") return;
      error = message;
      speakingSentence = null;
      buffer = EMPTY_BUFFER;
      transition("idle");
      notify();
    },
    subscribe(cb: () => void): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    snapshot(): ModeSnapshot {
      return cachedSnapshot;
    },
    epoch(): number {
      return stitchEpoch;
    },
    dispose(): void {
      subscribers.clear();
    },
  };
}
