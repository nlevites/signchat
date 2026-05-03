import "server-only";

import { createHash } from "node:crypto";
import type { MintOpenRouterSessionKeyResponse } from "@/lib/contracts";
import { ServerEnv } from "@/app/api/_helpers/env";
import { sanitizeIdentity, sanitizeRoom } from "@/app/api/_helpers/sanitize";
import { consumeToken, getClientIp } from "@/app/api/_helpers/rate-limit";
import { errorJson } from "@/app/api/_helpers/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Default credit cap per minted child key, in USD. ~100-200 turns at sub-cent
 * each (gemini-3-flash-preview pricing); see ARCHITECTURE.md s10.2. */
const DEFAULT_LIMIT_USD = 1.0;

/** Default OpenRouter model id the browser will use for reconstruction (s5.7). */
const DEFAULT_MODEL = "google/gemini-3-flash-preview";

const OR_KEYS_URL = "https://openrouter.ai/api/v1/keys";

interface OpenRouterCreateKeyResponse {
  key?: string;
  data?: { key?: string; hash?: string; label?: string };
  hash?: string;
  label?: string;
  // OpenRouter may surface additional fields; we only need `key`.
}

/**
 * POST /api/openrouter/session-key
 *
 * Mints a credit-capped child API key for browser-direct LLM calls. Deaf signer
 * only. Per ARCHITECTURE.md s10.2.
 *
 *   Request body: { roomId, identity, role: "deaf" }
 *   Response 200: MintOpenRouterSessionKeyResponse
 *   The returned `apiKey` is bounded by `limitCredits` and revocable via the
 *   provisioning key. Browser holds it in memory only.
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!consumeToken("openrouter-session-key", ip)) {
    return errorJson("rate_limited", 429);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson("invalid JSON body", 400);
    }
    const { roomId, identity, role } = (body ?? {}) as Record<string, unknown>;
    if (role !== "deaf") {
      return errorJson("only deaf signers mint OpenRouter session keys", 403);
    }
    const sanitizedRoom = sanitizeRoom(roomId);
    const sanitizedIdentity = sanitizeIdentity(identity);

    const env = ServerEnv.openrouter();
    const createdAt = new Date().toISOString();
    const label = `signchat:${sanitizedRoom}:${sanitizedIdentity}:${createdAt}`;

    const upstream = await fetch(OR_KEYS_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${env.managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: label,
        label,
        limit: DEFAULT_LIMIT_USD,
      }),
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      const trimmed = text.replace(/\s+/g, " ").slice(0, 200);
      console.warn(
        `[openrouter/session-key] upstream ${upstream.status}: ${trimmed}`,
      );
      return errorJson(
        `OpenRouter Management API ${upstream.status}: ${trimmed}`,
        upstream.status,
      );
    }
    const data = (await upstream.json()) as OpenRouterCreateKeyResponse;
    const apiKey = data.key ?? data.data?.key ?? "";
    if (!apiKey) {
      return errorJson("OpenRouter response missing key field", 502);
    }
    const keyHash = createHash("sha256").update(apiKey).digest("hex").slice(0, 16);

    const out: MintOpenRouterSessionKeyResponse = {
      apiKey,
      keyHash,
      label,
      limitCredits: DEFAULT_LIMIT_USD,
      modelId: DEFAULT_MODEL,
      createdAt,
    };
    // Never log apiKey. keyHash + label are safe and link the mint to the key
    // visible in the OpenRouter dashboard.
    console.info(
      `[openrouter/session-key] room=${sanitizedRoom} identity=${sanitizedIdentity} keyHash=${keyHash} label=${label}`,
    );
    return Response.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.warn(`[openrouter/session-key] error: ${message}`);
    return errorJson(message, 400);
  }
}
