import type { SignBuffer } from "@signchat/contracts";
import { SYSTEM_PROMPT } from "./system-prompt";

export type ReconstructionModelId =
  | "google/gemini-3-flash-preview"
  | "anthropic/claude-haiku-4.5"
  | "x-ai/grok-4.1-fast";

export interface ReconstructionRequest {
  model: ReconstructionModelId;
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature: 0;
  max_tokens: 300;
  response_format: { type: "json_object" };
}

export function buildReconstructionRequest(
  buffer: SignBuffer,
  transcriptContext: string[],
  modelId: ReconstructionModelId,
): ReconstructionRequest {
  const signs = buffer.tokens.map((t) => t.label);
  const lastFour = transcriptContext.slice(-4);

  const userContent =
    `Recognized signs: ${signs.length > 0 ? signs.join(" · ") : "(none)"}\n` +
    `Recent hearing transcript (last 4 lines):\n` +
    (lastFour.length > 0
      ? lastFour.map((line, i) => `${i + 1}. ${line}`).join("\n")
      : "(none)");

  return {
    model: modelId,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: { type: "json_object" },
  };
}
