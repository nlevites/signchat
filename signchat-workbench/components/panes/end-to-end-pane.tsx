"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function EndToEndPane() {
  useEffect(() => {
    LogBus.debug("e2e", "end-to-end pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="End-to-end Deaf-side turn"
      phase="Phase 6"
      summary="Wires phases 2-5 into one continuous turn: scripted classifier → mode controller → on Stitching call OpenRouter → on success render the inline preview UI → on Approve open ElevenLabs WSS → mix into signchat-voice → publish to LiveKit + broadcast caption with playAtMs (§6.2). Wired up in Phase 6."
      bullets={[
        "Scripted timeline picker: a few canned sign sequences",
        "Live FSM state badge through the whole turn",
        "Inline preview UX: Approve / Edit / Re-sign / Discard (§5.6)",
        "Per-stage latency vs §13 budget, red rows for over-budget",
        "'Open as Hearing user' button (mints Hearing token + opens new tab)",
        "Failure-mode tester: simulate llm_unavailable / tts_unavailable / session_budget_exhausted (§7)",
      ]}
    />
  );
}
