"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function ElevenLabsPane() {
  useEffect(() => {
    LogBus.debug("elevenlabs", "elevenlabs pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="ElevenLabs streaming TTS"
      phase="Phase 4"
      summary="Open the signed WSS URL minted by the lobby, stream pcm_24000 frames, decode + schedule against AudioContext, optionally mix with mic and publish as signchat-voice (§8). Wired up in Phase 4."
      bullets={[
        "Voice id field (defaults from ELEVENLABS_VOICE_ID)",
        "Sentence textarea (auto-sanitized: strip parens / brackets / asterisks / emoji)",
        "Speak (local) — TTS through speakers only, fastest visual confirmation",
        "Speak + duck mic — proves the §8.1 mixer locally",
        "Speak + publish to signchat-voice — proves the LiveKit publish path",
        "Latency markers per turn: signedUrl.fetch / wss.open / firstByte / firstScheduled / firstAudible",
        "Toggles: dtx (defaults false per §8.2), red, audioPreset",
      ]}
    />
  );
}
