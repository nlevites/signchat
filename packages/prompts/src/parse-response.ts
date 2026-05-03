import { z } from "zod";
import type { ReconstructionPayload } from "@signchat/contracts";

/**
 * Lean-options strict schema. `needsClarification` is intentionally optional:
 * the lean-options system prompt does not ask the model for it, and the
 * production `response_format` (json_schema strict) does not include it
 * either. We default it to `false` when absent so callers can still rely on
 * the {@link ReconstructionPayload} contract.
 */
const reconstructionResponseSchema = z.object({
  sentence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  matchedScriptId: z.string().nullable(),
  usedSigns: z.array(z.string()),
  needsClarification: z.boolean().optional(),
});

/**
 * Public schema, kept as a contract-typed `z.ZodType<ReconstructionPayload>`
 * for any external consumer that wants to validate the final shape rather
 * than the wire shape. Equivalent to the one above but with
 * `needsClarification` required.
 */
export const reconstructionPayloadSchema = z.object({
  sentence: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
  matchedScriptId: z.string().nullable(),
  usedSigns: z.array(z.string()),
  needsClarification: z.boolean(),
}) satisfies z.ZodType<ReconstructionPayload>;

export class ReconstructionParseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReconstructionParseError";
  }
}

export function parseReconstructionResponse(rawJson: unknown): ReconstructionPayload {
  const result = reconstructionResponseSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ReconstructionParseError(
      "OpenRouter response did not match ReconstructionPayload schema",
      { cause: result.error },
    );
  }
  return {
    sentence: result.data.sentence,
    confidence: result.data.confidence,
    matchedScriptId: result.data.matchedScriptId,
    usedSigns: result.data.usedSigns,
    needsClarification: result.data.needsClarification ?? false,
  };
}
