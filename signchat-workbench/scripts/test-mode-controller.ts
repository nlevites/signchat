// Smoke test for lib/mode-controller/mode-controller.ts
//
// Pure FSM + admit logic. No DOM, no SDK calls, no fetch — runs in
// <500 ms via tsx. Verifies the §9 transitions, the §9.3 admit rules,
// the epoch counter, and the Auto silence timer.
//
// Usage (from signchat-workbench/):
//   npm run smoke:mode-controller

import { createModeController } from "../lib/mode-controller/mode-controller";
import type { ClassifierResult } from "../lib/sign-pipeline/classifier";

function fail(msg: string): never {
  console.error("FAIL  " + msg);
  process.exit(1);
}
function ok(msg: string): void {
  console.log("OK    " + msg);
}

function makeTick(top: Array<[string, number]>): ClassifierResult {
  return {
    ts: performance.now(),
    top: top.map(([label, score]) => ({ label, score })),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ---- 1. happy path: stable admit + auto silence -> stitching --------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 200,
        inferenceIntervalMs: 500,
      },
      mode: "auto",
    });

    if (c.snapshot().state !== "idle") fail(`expected idle, got ${c.snapshot().state}`);
    ok("initial state: idle");

    c.start();
    if (c.snapshot().state !== "capturing") fail("start: not capturing");
    ok("start -> capturing");

    // Tick 1: PIZZA. Stable admit needs STABILITY_TICKS=2 — first tick is
    // memorized but does NOT admit yet.
    c.ingest(makeTick([["PIZZA", 0.85], ["ICECREAM", 0.05]]));
    if (c.snapshot().buffer.tokens.length !== 0) {
      fail(`first tick should not admit (need 2 stable); got ${c.snapshot().buffer.tokens.length}`);
    }
    ok("tick 1 PIZZA stored, not yet admitted (STABILITY_TICKS=2)");

    // Tick 2: PIZZA again. Stable admit fires.
    c.ingest(makeTick([["PIZZA", 0.86], ["ICECREAM", 0.05]]));
    const snap2 = c.snapshot();
    if (snap2.buffer.tokens.length !== 1) fail(`tick 2 should admit; got ${snap2.buffer.tokens.length}`);
    if (snap2.buffer.tokens[0]?.label !== "PIZZA") fail("admitted label mismatch");
    if (snap2.buffer.tokens[0]?.via !== "stable") fail(`expected via=stable, got ${snap2.buffer.tokens[0]?.via}`);
    ok("tick 2 PIZZA stable admit");

    // Tick 3: still PIZZA. Duplicate-label guard suppresses re-admission.
    c.ingest(makeTick([["PIZZA", 0.84], ["ICECREAM", 0.05]]));
    if (c.snapshot().buffer.tokens.length !== 1) fail("duplicate hold should not re-admit");
    ok("tick 3 PIZZA hold suppressed (duplicate-label guard)");

    // Wait for the silence timer (200 ms + slack).
    await sleep(280);
    if (c.snapshot().state !== "stitching") {
      fail(`expected stitching after silence, got ${c.snapshot().state}`);
    }
    ok("auto silence -> stitching");

    // Reconstruction arrives.
    c.setReconstruction({
      sentence: "Pizza sounds great!",
      confidence: "high",
      matchedScriptId: null,
      usedSigns: ["PIZZA"],
    });
    if (c.snapshot().state !== "preview") fail("setReconstruction did not transition to preview");
    if (c.snapshot().preview?.sentence !== "Pizza sounds great!") fail("preview sentence mismatch");
    ok("setReconstruction -> preview");

    // Approve with edited text.
    c.approve("Pizza!");
    const snapSpeak = c.snapshot();
    if (snapSpeak.state !== "speaking") fail("approve did not transition to speaking");
    if (snapSpeak.speakingSentence !== "Pizza!") fail("speaking sentence mismatch");
    ok("approve(text) -> speaking with edited text");

    c.speakingDone();
    if (c.snapshot().state !== "idle") fail("speakingDone did not return to idle");
    ok("speakingDone -> idle");

    c.dispose();
  }

  // ---- 2. cancel during capturing bumps epoch ------------------------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 5000,
        inferenceIntervalMs: 500,
      },
      mode: "manual",
    });
    c.start();
    c.ingest(makeTick([["YES", 0.8], ["NO", 0.05]]));
    c.ingest(makeTick([["YES", 0.8], ["NO", 0.05]]));
    if (c.snapshot().buffer.tokens.length !== 1) fail("expected one admitted token");
    const epochBefore = c.epoch();

    c.cancel();
    if (c.snapshot().state !== "idle") fail("cancel did not return to idle");
    if (c.snapshot().buffer.tokens.length !== 0) fail("cancel did not clear buffer");
    if (c.epoch() <= epochBefore) fail("cancel did not bump epoch");
    ok("cancel during capturing -> idle, epoch bumped");

    // Late reconstruction (would happen if a stale OpenRouter call resolved
    // after the user cancelled). Should be a no-op since state !== stitching.
    c.setReconstruction({
      sentence: "stale",
      confidence: "low",
      matchedScriptId: null,
      usedSigns: [],
    });
    if (c.snapshot().state !== "idle") fail("late setReconstruction should no-op");
    ok("late setReconstruction is a no-op after cancel");

    c.dispose();
  }

  // ---- 3. manual mode does not auto-stitch ---------------------------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 100,
        inferenceIntervalMs: 500,
      },
      mode: "manual",
    });
    c.start();
    c.ingest(makeTick([["FINE", 0.8], ["HAPPY", 0.05]]));
    c.ingest(makeTick([["FINE", 0.8], ["HAPPY", 0.05]]));
    await sleep(180);
    if (c.snapshot().state !== "capturing") {
      fail(`manual mode should not auto-stitch; got ${c.snapshot().state}`);
    }
    ok("manual mode ignores silence timer");

    c.stopManual();
    if (c.snapshot().state !== "stitching") fail("stopManual did not transition to stitching");
    ok("stopManual -> stitching");

    c.dispose();
  }

  // ---- 4. band admit per §9.3 ----------------------------------------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 5000,
        inferenceIntervalMs: 500,
      },
      mode: "manual",
    });
    c.start();

    // Single tick with top1 in the band [0.3, 0.5) and top2 >= 0.3 — band-admit
    // fires immediately (no STABILITY_TICKS gate for band admits).
    c.ingest(makeTick([["PIZZA", 0.45], ["ICECREAM", 0.4]]));
    if (c.snapshot().buffer.tokens.length !== 1) {
      fail(
        `band admit should fire on first band tick; got ${c.snapshot().buffer.tokens.length}`,
      );
    }
    const t = c.snapshot().buffer.tokens[0]!;
    if (t.via !== "band") fail(`expected via=band, got ${t.via}`);
    if (t.label !== "PIZZA") fail(`expected PIZZA, got ${t.label}`);
    ok("band admit: top1 in [top2Thr, top1Thr) + top2 >= top2Thr fires immediately");

    // Hold the same band tick — duplicate-label guard suppresses re-admit.
    c.ingest(makeTick([["PIZZA", 0.45], ["ICECREAM", 0.4]]));
    if (c.snapshot().buffer.tokens.length !== 1) {
      fail("band duplicate-label hold should not re-admit");
    }
    ok("band duplicate-label guard on hold");

    // Switch top1 to a different band token — admits.
    c.ingest(makeTick([["ICECREAM", 0.45], ["PIZZA", 0.4]]));
    if (c.snapshot().buffer.tokens.length !== 2) {
      fail(`expected 2 admits after band switch; got ${c.snapshot().buffer.tokens.length}`);
    }
    if (c.snapshot().buffer.tokens[1]?.via !== "band") fail("second admit not via band");
    if (c.snapshot().buffer.tokens[1]?.label !== "ICECREAM") fail("second admit label mismatch");
    ok("band admit: top1 changes to a new in-band label");

    // Below band on both — no admit.
    c.ingest(makeTick([["WATER", 0.25], ["MILK", 0.2]]));
    if (c.snapshot().buffer.tokens.length !== 2) {
      fail("below-band tick should not admit");
    }
    ok("below-band scores: no admit");

    c.dispose();
  }

  // ---- 5. failure modes (LLM error, TTS error) -----------------------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 100,
        inferenceIntervalMs: 500,
      },
      mode: "auto",
    });
    c.start();
    c.ingest(makeTick([["PIZZA", 0.85], ["ICECREAM", 0.05]]));
    c.ingest(makeTick([["PIZZA", 0.86], ["ICECREAM", 0.05]]));
    await sleep(180);
    if (c.snapshot().state !== "stitching") fail("expected stitching for LLM error test");
    c.setLLMError("forced llm_unavailable");
    const snap = c.snapshot();
    if (snap.state !== "idle") fail("setLLMError did not return to idle");
    if (snap.buffer.tokens.length !== 0) fail("setLLMError did not clear buffer");
    if (snap.error !== "forced llm_unavailable") fail("setLLMError did not surface message");
    ok("setLLMError -> idle + buffer cleared + error surfaced");

    c.start();
    c.ingest(makeTick([["YES", 0.85], ["NO", 0.05]]));
    c.ingest(makeTick([["YES", 0.86], ["NO", 0.05]]));
    await sleep(180);
    c.setReconstruction({
      sentence: "Yes!",
      confidence: "high",
      matchedScriptId: null,
      usedSigns: ["YES"],
    });
    c.approve("Yes!");
    if (c.snapshot().state !== "speaking") fail("expected speaking for TTS error test");
    c.speakingError("forced tts_unavailable");
    if (c.snapshot().state !== "idle") fail("speakingError did not return to idle");
    if (c.snapshot().error !== "forced tts_unavailable") fail("speakingError did not surface message");
    ok("speakingError -> idle + error surfaced");

    c.dispose();
  }

  // ---- 6. resign / discard from preview -------------------------------------

  {
    const c = createModeController({
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 100,
        inferenceIntervalMs: 500,
      },
      mode: "auto",
    });
    c.start();
    c.ingest(makeTick([["HAPPY", 0.8], ["FINE", 0.05]]));
    c.ingest(makeTick([["HAPPY", 0.8], ["FINE", 0.05]]));
    await sleep(180);
    c.setReconstruction({
      sentence: "I'm happy.",
      confidence: "high",
      matchedScriptId: null,
      usedSigns: ["HAPPY"],
    });
    if (c.snapshot().state !== "preview") fail("not in preview");

    c.resign();
    if (c.snapshot().state !== "capturing") fail("resign did not return to capturing");
    if (c.snapshot().buffer.tokens.length !== 0) fail("resign did not clear buffer");
    ok("resign -> capturing with empty buffer");

    // Get back to preview to test discard.
    c.ingest(makeTick([["HAPPY", 0.8], ["FINE", 0.05]]));
    c.ingest(makeTick([["HAPPY", 0.8], ["FINE", 0.05]]));
    await sleep(180);
    c.setReconstruction({
      sentence: "I'm happy.",
      confidence: "high",
      matchedScriptId: null,
      usedSigns: ["HAPPY"],
    });
    c.discard();
    if (c.snapshot().state !== "idle") fail("discard did not return to idle");
    if (c.snapshot().buffer.tokens.length !== 0) fail("discard did not clear buffer");
    ok("discard -> idle with empty buffer");

    c.dispose();
  }

  console.log("\nmode-controller smoke: PASS");
}

main().catch((err) => {
  console.error("\nFAIL  unexpected error: " + (err instanceof Error ? err.stack : String(err)));
  process.exit(1);
});
