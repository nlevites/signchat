"use client";

import type { Classifier, ClassifierResult, ClassifierState } from "./classifier";

/**
 * Hermetic timeline-replay classifier for the Phase 6 end-to-end pane and
 * for any future regression tests that need a deterministic source of
 * `ClassifierResult`s. Implements the same `Classifier` interface as the
 * live MediaPipeOnnxClassifier (Phase 5), so the consumer doesn't care
 * which one is hooked up.
 *
 * Timelines are tuned to satisfy the §9.3 admit logic (stable-admit needs
 * STABILITY_TICKS=2 consecutive same-label top1s above top1Threshold).
 */

export interface ScriptedTick {
  /** Top-K predictions for this tick; index 0 is top-1. */
  top: ReadonlyArray<{ label: string; score: number }>;
}

export interface ScriptedTimeline {
  id: string;
  /** Human label rendered in the picker. */
  label: string;
  /** Inter-tick interval. 500 ms matches the §5.4 default classifier cadence. */
  tickMs: number;
  ticks: ReadonlyArray<ScriptedTick>;
  /** Optional preview of what the LLM should reconstruct (UI hint only). */
  expected: string;
}

const FILLER = (label: string): { label: string; score: number } => ({
  label,
  score: 0.05,
});

// PIZZA — single-token sentence. Two consecutive stable ticks satisfy the
// §9.3 stable-admit rule; the hold tick after admission is suppressed by
// the duplicate-label guard.
const PIZZA_TIMELINE: ScriptedTimeline = {
  id: "PIZZA",
  label: "PIZZA — single token",
  tickMs: 500,
  expected: "Pizza sounds great!",
  ticks: [
    {
      top: [
        { label: "PIZZA", score: 0.85 },
        FILLER("ICECREAM"),
        FILLER("WATER"),
      ],
    },
    {
      top: [
        { label: "PIZZA", score: 0.86 },
        FILLER("ICECREAM"),
        FILLER("WATER"),
      ],
    },
    {
      top: [
        { label: "PIZZA", score: 0.84 },
        FILLER("ICECREAM"),
        FILLER("WATER"),
      ],
    },
  ],
};

// HAPPY — exercise the band-admit branch with a top1 in the band but a
// lower-confidence top2 also above top2Threshold. The controller admits
// the top1 as `via: "band"`.
const HAPPY_TIMELINE: ScriptedTimeline = {
  id: "HAPPY",
  label: "HAPPY — single token (stable)",
  tickMs: 500,
  expected: "I'm happy.",
  ticks: [
    {
      top: [
        { label: "HAPPY", score: 0.78 },
        FILLER("FINE"),
        FILLER("MAD"),
      ],
    },
    {
      top: [
        { label: "HAPPY", score: 0.81 },
        FILLER("FINE"),
        FILLER("MAD"),
      ],
    },
  ],
};

// YES + DOG + CAT — three-token sentence. Each pair of stable ticks admits
// one token; the controller's duplicate-label guard prevents the hold ticks
// from re-admitting.
const YES_DOG_CAT_TIMELINE: ScriptedTimeline = {
  id: "YES_DOG_CAT",
  label: "YES DOG CAT — multi-token",
  tickMs: 500,
  expected: "Yes, a dog and a cat.",
  ticks: [
    {
      top: [
        { label: "YES", score: 0.82 },
        FILLER("NO"),
        FILLER("PLEASE"),
      ],
    },
    {
      top: [
        { label: "YES", score: 0.84 },
        FILLER("NO"),
        FILLER("PLEASE"),
      ],
    },
    {
      top: [
        { label: "DOG", score: 0.79 },
        FILLER("CAT"),
        FILLER("HORSE"),
      ],
    },
    {
      top: [
        { label: "DOG", score: 0.81 },
        FILLER("CAT"),
        FILLER("HORSE"),
      ],
    },
    {
      top: [
        { label: "CAT", score: 0.83 },
        FILLER("DOG"),
        FILLER("HORSE"),
      ],
    },
    {
      top: [
        { label: "CAT", score: 0.85 },
        FILLER("DOG"),
        FILLER("HORSE"),
      ],
    },
  ],
};

// FINE + THANKYOU — greeting-flavor reconstruction.
const FINE_THANKYOU_TIMELINE: ScriptedTimeline = {
  id: "FINE_THANKYOU",
  label: "FINE THANKYOU — greeting",
  tickMs: 500,
  expected: "I'm fine, thank you.",
  ticks: [
    {
      top: [
        { label: "FINE", score: 0.81 },
        FILLER("HAPPY"),
        FILLER("MAD"),
      ],
    },
    {
      top: [
        { label: "FINE", score: 0.83 },
        FILLER("HAPPY"),
        FILLER("MAD"),
      ],
    },
    {
      top: [
        { label: "THANKYOU", score: 0.78 },
        FILLER("PLEASE"),
        FILLER("YES"),
      ],
    },
    {
      top: [
        { label: "THANKYOU", score: 0.80 },
        FILLER("PLEASE"),
        FILLER("YES"),
      ],
    },
  ],
};

export const SCRIPTED_TIMELINES: ReadonlyArray<ScriptedTimeline> = [
  PIZZA_TIMELINE,
  HAPPY_TIMELINE,
  YES_DOG_CAT_TIMELINE,
  FINE_THANKYOU_TIMELINE,
];

/**
 * Build a Classifier that emits the given timeline tick-by-tick once
 * `start()` is called. `stop()` cancels the pending interval cleanly.
 *
 * The resulting Classifier never enters `error` state and is reusable
 * across multiple start/stop cycles (each `start()` replays from tick 0).
 */
export function createScriptedClassifier(
  timeline: ScriptedTimeline,
): Classifier {
  let state: ClassifierState = "idle";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const resultSubs = new Set<(r: ClassifierResult) => void>();
  const stateSubs = new Set<(s: ClassifierState, err?: Error) => void>();

  function setState(next: ClassifierState, err?: Error): void {
    state = next;
    for (const cb of stateSubs) {
      try {
        cb(state, err);
      } catch {
        // ignore
      }
    }
  }

  function emitTick(idx: number): void {
    const tick = timeline.ticks[idx];
    if (!tick) {
      // Timeline exhausted. We stay in `running` so the controller's
      // silence timer (Auto) or the operator's Stop click (Manual) drives
      // the Capturing → Stitching transition.
      return;
    }
    const result: ClassifierResult = {
      ts: performance.now(),
      top: tick.top.map((p) => ({ label: p.label, score: p.score })),
    };
    for (const cb of resultSubs) {
      try {
        cb(result);
      } catch {
        // ignore
      }
    }
    timer = setTimeout(() => emitTick(idx + 1), timeline.tickMs);
  }

  return {
    async start(): Promise<void> {
      if (state === "running" || state === "starting") return;
      setState("starting");
      // Emit tick 0 on next microtask so consumers can subscribe between
      // `start()` and the first result in the same tick of the event loop.
      timer = setTimeout(() => {
        if (state === "starting") setState("running");
        emitTick(0);
      }, 0);
    },
    async stop(): Promise<void> {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (state !== "stopped" && state !== "idle") {
        setState("stopped");
      }
    },
    onResult(cb): () => void {
      resultSubs.add(cb);
      return () => {
        resultSubs.delete(cb);
      };
    },
    onStateChange(cb): () => void {
      stateSubs.add(cb);
      return () => {
        stateSubs.delete(cb);
      };
    },
    state(): ClassifierState {
      return state;
    },
  };
}
