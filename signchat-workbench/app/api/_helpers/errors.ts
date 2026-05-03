import "server-only";

import type { MintErrorResponse } from "@/lib/contracts";

/**
 * JSON error response builder. Always emits `{ error: string }` per the
 * MintErrorResponse contract.
 */
export function errorJson(message: string, status = 400): Response {
  const body: MintErrorResponse = { error: message };
  return Response.json(body, { status });
}
