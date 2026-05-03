"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function WhisperPane() {
  useEffect(() => {
    LogBus.debug("whisper", "whisper pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="Whisper + Silero VAD (Hearing → Deaf captions)"
      phase="Phase 7 (deferred)"
      summary="Subscribe to the Hearing user's remote audio track, run Silero VAD-gated transformers.js Whisper, broadcast transcript_partial / transcript_final over the data channel (§5.8). Lowest priority — §7 explicitly tolerates 'captions unavailable'. Wired up if time permits."
      bullets={[
        "Whisper variant dropdown: tiny.en / base.en (default) / small.en (§5.8)",
        "Live PCM waveform visualization",
        "VAD speech-start / speech-end events",
        "Streaming partials replacing in place, finals locking the line",
        "Quality indicator: 'captions: degraded' chip when p50 > 1.5s for 3 utterances",
      ]}
    />
  );
}
