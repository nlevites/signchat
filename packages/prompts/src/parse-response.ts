import { z } from "zod";
import type { ReconstructionPayload } from "@signchat/contracts";

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
  const result = reconstructionPayloadSchema.safeParse(rawJson);
  if (!result.success) {
    throw new ReconstructionParseError(
      "OpenRouter response did not match ReconstructionPayload schema",
      { cause: result.error },
    );
  }
  return result.data;
}
