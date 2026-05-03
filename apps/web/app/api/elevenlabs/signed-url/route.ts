import type { CreateElevenLabsSignedUrlResponse } from "@signchat/contracts";
import {
  BadRequest,
  Forbidden,
  respondError,
  sanitizeIdentity,
  sanitizeRoomId,
} from "@/lib/api/sanitize";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

// elevenlabs single-use-token endpoint (15-min TTL); token embedded as ?single_use_token in the WSS url.
const ELEVENLABS_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/tts_websocket";
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MODEL_ID = "eleven_flash_v2_5" as const;
const OUTPUT_FORMAT = "pcm_24000" as const;

function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "unknown";
}

function readEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

function buildSignedWssUrl(voiceId: string, singleUseToken: string): string {
  const url = new URL(
    `wss://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream-input`,
  );
  url.searchParams.set("model_id", MODEL_ID);
  url.searchParams.set("output_format", OUTPUT_FORMAT);
  url.searchParams.set("single_use_token", singleUseToken);
  return url.toString();
}

export async function POST(req: Request): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      throw new BadRequest("invalid_json");
    }

    if (typeof body !== "object" || body === null) {
      throw new BadRequest("invalid_body");
    }

    const {
      roomId: rawRoomId,
      identity: rawIdentity,
      role,
      voiceId: rawVoiceId,
    } = body as Record<string, unknown>;

    const roomId = sanitizeRoomId(rawRoomId);
    const identity = sanitizeIdentity(rawIdentity);
    if (role !== "deaf") throw new Forbidden("deaf_only");

    enforceRateLimit(getClientIp(req), roomId);

    const apiKey = readEnv("ELEVENLABS_API_KEY");
    const defaultVoiceId = readEnv("ELEVENLABS_VOICE_ID");
    const voiceId =
      typeof rawVoiceId === "string" && rawVoiceId.trim().length > 0
        ? rawVoiceId.trim()
        : defaultVoiceId;

    const upstream = await fetch(ELEVENLABS_TOKEN_URL, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    });

    if (!upstream.ok) {
      const text = await upstream.text().catch(() => "");
      console.error(
        "elevenlabs token mint failed",
        upstream.status,
        text.replace(/\s+/g, " ").slice(0, 200),
      );
      throw new Error("elevenlabs_mint_failed");
    }

    const data = (await upstream.json()) as { token?: string };
    const singleUseToken = data.token;
    if (!singleUseToken) {
      throw new Error("elevenlabs_mint_no_token");
    }

    const signedUrl = buildSignedWssUrl(voiceId, singleUseToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    console.log("minted elevenlabs signed url", {
      roomId,
      identity,
      voiceId,
      expiresAt,
    });

    const respBody: CreateElevenLabsSignedUrlResponse = {
      signedUrl,
      voiceId,
      modelId: MODEL_ID,
      outputFormat: OUTPUT_FORMAT,
      expiresAt,
    };
    return Response.json(respBody);
  } catch (err) {
    return respondError(err);
  }
}
