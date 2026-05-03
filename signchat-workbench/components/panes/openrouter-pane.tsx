"use client";

import { useEffect } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { PanePlaceholder } from "./pane-placeholder";

export function OpenRouterPane() {
  useEffect(() => {
    LogBus.debug("openrouter", "openrouter pane mounted");
  }, []);

  return (
    <PanePlaceholder
      title="OpenRouter reconstruction"
      phase="Phase 3"
      summary="Browser-direct chat/completions call against OpenRouter using the lobby's minted session key. response_format: json_schema strict, the frozen winning prompt copied from prompt-tester-service. Wired up in Phase 3."
      bullets={[
        "Model dropdown: defaults to google/gemini-3-flash-preview (§5.7)",
        "Canned recognized-token sequence picker (from prompt-tester fixtures)",
        "Optional hearing-transcript context input",
        "Run button: shows raw + parsed response, latency, token usage, cost",
        "'model unavailable' chip when the saved id isn't in the catalog",
      ]}
    />
  );
}
