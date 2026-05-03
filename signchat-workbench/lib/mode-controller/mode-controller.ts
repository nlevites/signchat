/**
 * Pure §9 mode controller. Owns the FSM, the SignBuffer, the §9.3 admit
 * logic, and the Auto silence timer. No React, no DOM, no SDK calls — the
 * pane wires async work (OpenRouter, ElevenLabs, LiveKit publish) on top
 * of the controller's state transitions and notifies the controller of
 * results via `setReconstruction`, `speakingDone`, etc.
 *
 * Single-shot per pane: `createModeController()` returns a fresh
 * controller; the pane disposes it on unmount via the returned `dispose`
 * method (clears any pending silence timer). State changes notify
 * subscribers synchronously; subscribers should call `snapshot()` to
 * read the immutable view.
 */

import {
  DEFAULT_AUTO_THRESHOLDS,
  STABILITY_TICKS,
  type AutoThresholds,
  type CaptureMode,
  type ModeState,
  type ReconstructionPayload,
  type SignBuffer,
  type SignToken,
} from "@/lib/contracts";
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
  /** Wall-clock ms when the current state was entered; useful for ageing the silence timer in the UI. */
  enteredStateAt: number;
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
  /** Stop silence timer + drop subscribers. Call from unmount. */
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
  let cachedSnapshot: ModeSnapshot = buildSnapshot();

  // Admit-logic memory.
  let lastTickTop1: { label: string; score: number } | null = null;
  let lastAdmitLabel: string | null = null;
  let stitchEpoch = 0;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
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
  }

  function clearSilenceTimer(): void {
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function armSilenceTimer(): void {
    clearSilenceTimer();
    if (mode !== "auto" || state !== "capturing") return;
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      // Only ship if the buffer has at least one admit and we're still
      // in capturing — Cancel/Discard would have transitioned already.
      if (state !== "capturing") return;
      if (buffer.tokens.length === 0) {
        // No admits during the silence window; nothing to say. Stay in
        // capturing and re-arm so the user can keep signing.
        armSilenceTimer();
        return;
      }
      stitchEpoch += 1;
      transition("stitching");
      notify();
    }, thresholds.silenceMs);
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
      // Re-arm or cancel silence timer to match the new mode.
      if (state === "capturing") {
        if (mode === "auto") armSilenceTimer();
        else clearSilenceTimer();
      }
      notify();
    },
    setThresholds(next: AutoThresholds): void {
      thresholds = { ...next };
      if (state === "capturing" && mode === "auto") armSilenceTimer();
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
      armSilenceTimer();
      notify();
    },
    stopManual(): void {
      if (state !== "capturing") return;
      if (buffer.tokens.length === 0) return; // nothing to stitch
      clearSilenceTimer();
      stitchEpoch += 1;
      transition("stitching");
      notify();
    },
    cancel(): void {
      if (state !== "capturing") return;
      clearSilenceTimer();
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
      armSilenceTimer();
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
      if (state !== "capturing") {
        // Stale ticks during stitching/preview/speaking are silently
        // dropped — the controller only consumes ClassifierResults while
        // capturing.
        return;
      }
      if (result.top.length === 0) {
        return;
      }
      const top1 = result.top[0]!;
      const top2 = result.top[1] ?? null;

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

      if (admitted) {
        admit(admitted);
        if (mode === "auto") armSilenceTimer();
      }

      lastTickTop1 = { label: top1.label, score: top1.score };
      if (admitted) notify();
    },
    setReconstruction(payload: ReconstructionPayload): void {
      // Only accept while in stitching; if a Cancel/Discard fired, the state
      // will already be `idle` and we drop this stale callback.
      if (state !== "stitching") return;
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
      clearSilenceTimer();
      subscribers.clear();
    },
  };
}
