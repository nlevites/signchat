"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function LobbyPane() {
  useEffect(() => {
    LogBus.debug("lobby", "lobby pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="Lobby"
      phase="Phase 1"
      summary="Pick role + room id, mint LiveKit JWT + OpenRouter session key + ElevenLabs signed URL, render the JSON for each. Wired up in Phase 1."
      bullets={[
        "Role selector: deaf | hearing",
        "Room id input (sanitized to [a-zA-Z0-9_- ]{1,64})",
        "Identity input (defaults to a generated handle)",
        "Mint button hits all three /api/* routes in parallel",
        "Status row per credential with masked sensitive values",
      ]}
    />
  );
}
