import "server-only";

import type { MintElevenLabsSignedUrlResponse } from "@/lib/contracts";
import { ServerEnv } from "@/app/api/_helpers/env";
import { sanitizeIdentity, sanitizeRoom } from "@/app/api/_helpers/sanitize";
import { consumeToken, getClientIp } from "@/app/api/_helpers/rate-limit";
import { errorJson } from "@/app/api/_helpers/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * ElevenLabs single-use TTS WebSocket token endpoint.
 * https://elevenlabs.io/docs/api-reference/tokens/create
 *
 * Returns { token } with a 15-minute TTL. Consumed on first WSS connect.
 */
const EL_SINGLE_USE_URL =
  "https://api.elevenlabs.io/v1/single-use-token/tts_websocket";

const TOKEN_TTL_MS = 15 * 60 * 1000; // documented: 15 minutes

interface ElevenLabsSingleUseTokenResponse {
  token?: string;
}

/**
 * Build the fully-formed WSS URL the browser will open.
 *
 * Per ElevenLabs docs (https://elevenlabs.io/docs/eleven-api/guides/how-to/websockets/realtime-tts):
 *   wss://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream-input
 *     ?model_id=<model>
 *     &output_format=<format>
 *     &single_use_token=<token>
 */
function buildSignedWssUrl(args: {
  voiceId: string;
  modelId: "eleven_flash_v2_5";
  outputFormat: "pcm_24000";
  singleUseToken: string;
}): string {
  const url = new URL(
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(args.voiceId)}/stream-input`,
  );
  url.searchParams.set("model_id", args.modelId);
  url.searchParams.set("output_format", args.outputFormat);
  url.searchParams.set("single_use_token", args.singleUseToken);
  return url.toString();
}

/**
 * POST /api/elevenlabs/signed-url
 *
 * Mints a single-use TTS WebSocket token via the ElevenLabs API and returns
 * the fully-formed signed WSS URL the Deaf signer's browser will open. Per
 * ARCHITECTURE.md s10.3.
 *
 *   Request body: { roomId, identity, role: "deaf", voiceId?, modelId?, outputFormat? }
 *   Response 200: MintElevenLabsSignedUrlResponse
 *
 * `voiceId` defaults to ELEVENLABS_VOICE_ID. `modelId` defaults to
 * eleven_flash_v2_5; `outputFormat` defaults to pcm_24000 (matches the
 * 24 kHz AudioContext per s8.1).
 */
export async function POST(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!consumeToken("elevenlabs-signed-url", ip)) {
    return errorJson("rate_limited", 429);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return errorJson("invalid JSON body", 400);
    }
    const { roomId, identity, role, voiceId, modelId, outputFormat } =
      (body ?? {}) as Record<string, unknown>;
    if (role !== "deaf") {
      return errorJson("only deaf signers mint ElevenLabs signed URLs", 403);
    }
    const sanitizedRoom = sanitizeRoom(roomId);
    const sanitizedIdentity = sanitizeIdentity(identity);

    const env = ServerEnv.elevenlabs();
    const resolvedVoiceId =
      typeof voiceId === "string" && voiceId.trim().length > 0
        ? voiceId.trim()
        : env.defaultVoiceId;
    const resolvedModelId: "eleven_flash_v2_5" =
      modelId === "eleven_flash_v2_5" || modelId === undefined
        ? "eleven_flash_v2_5"
        : "eleven_flash_v2_5";
    const resolvedOutputFormat: "pcm_24000" =
      outputFormat === "pcm_24000" || outputFormat === undefined
        ? "pcm_24000"
        : "pcm_24000";

    const upstream = await fetch(EL_SINGLE_USE_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        "xi-api-key": env.apiKey,
        "Content-Type": "application/json",
      },
      // Body intentionally empty: token type lives in the URL path.
      body: "{}",
    });
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      const trimmed = text.replace(/\s+/g, " ").slice(0, 200);
      console.warn(
        `[elevenlabs/signed-url] upstream ${upstream.status}: ${trimmed}`,
      );
      return errorJson(
        `ElevenLabs single-use token API ${upstream.status}: ${trimmed}`,
        upstream.status,
      );
    }
    const data = (await upstream.json()) as ElevenLabsSingleUseTokenResponse;
    const singleUseToken = data.token ?? "";
    if (!singleUseToken) {
      return errorJson("ElevenLabs response missing token field", 502);
    }

    const signedUrl = buildSignedWssUrl({
      voiceId: resolvedVoiceId,
      modelId: resolvedModelId,
      outputFormat: resolvedOutputFormat,
      singleUseToken,
    });
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    const out: MintElevenLabsSignedUrlResponse = {
      signedUrl,
      voiceId: resolvedVoiceId,
      modelId: resolvedModelId,
      outputFormat: resolvedOutputFormat,
      expiresAt,
    };
    // Never log the signedUrl or token; the voiceId is safe.
    console.info(
      `[elevenlabs/signed-url] room=${sanitizedRoom} identity=${sanitizedIdentity} voiceId=${resolvedVoiceId} expiresAt=${expiresAt}`,
    );
    return Response.json(out);
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.warn(`[elevenlabs/signed-url] error: ${message}`);
    return errorJson(message, 400);
  }
}
