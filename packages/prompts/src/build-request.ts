import { LEAN_OPTIONS_SYSTEM } from "./system-prompt";
import { dictionaryLabel } from "./vocabulary";

export type ReconstructionModelId =
  | "openai/gpt-5.4-mini"
  | "google/gemini-3-flash-preview"
  | "anthropic/claude-haiku-4.5"
  | "x-ai/grok-4.1-fast";

export interface SignTokenAlternative {
  word: string;
  score: number;
}

/**
 * Per-frame top-K classifier output for a single sign turn. Order matters —
 * it's the temporal order the signer produced the signs in. The lean-options
 * template renders the full top-K (top-1 + alternatives) into the user
 * prompt verbatim plus a per-token `Word translations` block.
 */
export interface SignTokenTopK {
  word: string;
  score: number;
  alternatives: readonly SignTokenAlternative[];
}

const LEAN_OPTIONS_USER = `Hearing said: {{hearingTranscript}}
Top-K classifier output for the current sign turn:
{{signTokensTopK}}
Word translations: {{recognizedSignsTopKDictionary}}

Return JSON only.`;

/**
 * OpenAI-style `response_format` body fragment. Tightened from `json_object`
 * to `json_schema` strict — the prompt-tester sweep
 * (prompt-tester-service/charts/RESULTS.md) showed every dropdown model
 * obeys the strict schema without a healing pass, and the workbench has
 * been running on this since the sweep concluded.
 *
 * `needsClarification` is intentionally absent: the lean-options system
 * prompt does not ask for it, so we keep it out of the strict schema as
 * well. The Zod parser in parse-response.ts treats it as optional for
 * back-compat.
 */
const LEAN_OPTIONS_RESPONSE_FORMAT = {
  type: "json_schema" as const,
  json_schema: {
    name: "reconstruction_payload",
    strict: true,
    schema: {
      type: "object" as const,
      properties: {
        sentence: { type: "string" as const },
        confidence: {
          type: "string" as const,
          enum: ["high", "medium", "low"] as const,
        },
        matchedScriptId: { type: ["string", "null"] as const },
        usedSigns: {
          type: "array" as const,
          items: { type: "string" as const },
        },
      },
      required: ["sentence", "confidence", "matchedScriptId", "usedSigns"],
      additionalProperties: false,
    },
  },
};

export interface ReconstructionRequest {
  model: ReconstructionModelId;
  messages: Array<{ role: "system" | "user"; content: string }>;
  temperature: 0;
  max_tokens: 300;
  response_format: typeof LEAN_OPTIONS_RESPONSE_FORMAT;
}

export interface BuildReconstructionRequestArgs {
  /** The hearing user's most recent transcript line. Empty string is fine. */
  hearingTranscript: string;
  /** Per-frame top-K classifier output for the current sign turn. */
  topK: ReadonlyArray<SignTokenTopK>;
  modelId: ReconstructionModelId;
}

export function buildReconstructionRequest(
  args: BuildReconstructionRequestArgs,
): ReconstructionRequest {
  const userPrompt = composeUserPrompt({
    hearingTranscript: args.hearingTranscript,
    topK: args.topK,
  });
  return {
    model: args.modelId,
    messages: [
      { role: "system", content: LEAN_OPTIONS_SYSTEM },
      { role: "user", content: userPrompt },
    ],
    temperature: 0,
    max_tokens: 300,
    response_format: LEAN_OPTIONS_RESPONSE_FORMAT,
  };
}

export interface ComposeUserPromptArgs {
  hearingTranscript: string;
  topK: ReadonlyArray<SignTokenTopK>;
}

/**
 * Fill the three placeholders that the lean-options user template uses
 * ({{hearingTranscript}}, {{signTokensTopK}}, {{recognizedSignsTopKDictionary}})
 * and return the composed user prompt as a string.
 */
export function composeUserPrompt(args: ComposeUserPromptArgs): string {
  const hearing =
    args.hearingTranscript.trim().length > 0
      ? args.hearingTranscript
      : "(none)";
  const topKBlock = JSON.stringify(args.topK, null, 2);
  const dictBlock = formatRecognizedSignsTopKDictionary(args.topK);
  return LEAN_OPTIONS_USER.replaceAll("{{hearingTranscript}}", hearing)
    .replaceAll("{{signTokensTopK}}", topKBlock)
    .replaceAll("{{recognizedSignsTopKDictionary}}", dictBlock);
}

/**
 * Translation lines for every distinct token referenced by this turn's
 * top-K (top-1 plus all alternatives), one per line, alphabetized for
 * stable output. Stays small because only this turn's words appear, not
 * the full 250-class catalog.
 */
export function formatRecognizedSignsTopKDictionary(
  topK: ReadonlyArray<SignTokenTopK>,
): string {
  const tokens = new Set<string>();
  for (const slot of topK) {
    tokens.add(slot.word);
    for (const alt of slot.alternatives) tokens.add(alt.word);
  }
  return [...tokens]
    .sort()
    .map((t) => `${t}=${dictionaryLabel(t)}`)
    .join("\n");
}
