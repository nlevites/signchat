import type { CreateElevenLabsSttSignedUrlResponse } from "@signchat/contracts";
import {
  BadRequest,
  Forbidden,
  respondError,
  sanitizeIdentity,
  sanitizeRoomId,
} from "@/lib/api/sanitize";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

// elevenlabs realtime-scribe single-use-token endpoint (15-min TTL); token
// embedded as ?token in the WSS url. Distinct from the tts_websocket token
// minted in ./signed-url/route.ts.
const ELEVENLABS_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const TOKEN_TTL_MS = 15 * 60 * 1000;
const MODEL_ID = "scribe_v2_realtime" as const;
const AUDIO_FORMAT = "pcm_16000" as const;
const COMMIT_STRATEGY = "vad" as const;
// Lock Scribe to English so auto-detect doesn't flip into another language
// when accent / mic noise / cross-talk confuses per-utterance detection.
const LANGUAGE_CODE = "en" as const;

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

function buildSignedWssUrl(singleUseToken: string): string {
  const url = new URL(
    "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
  );
  url.searchParams.set("model_id", MODEL_ID);
  url.searchParams.set("audio_format", AUDIO_FORMAT);
  url.searchParams.set("commit_strategy", COMMIT_STRATEGY);
  url.searchParams.set("language_code", LANGUAGE_CODE);
  url.searchParams.set("token", singleUseToken);
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
    } = body as Record<string, unknown>;

    const roomId = sanitizeRoomId(rawRoomId);
    const identity = sanitizeIdentity(rawIdentity);
    if (role !== "deaf") throw new Forbidden("deaf_only");

    enforceRateLimit(getClientIp(req), roomId);

    const apiKey = readEnv("ELEVENLABS_API_KEY");

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
        "elevenlabs stt token mint failed",
        upstream.status,
        text.replace(/\s+/g, " ").slice(0, 200),
      );
      throw new Error("elevenlabs_stt_mint_failed");
    }

    const data = (await upstream.json()) as { token?: string };
    const singleUseToken = data.token;
    if (!singleUseToken) {
      throw new Error("elevenlabs_stt_mint_no_token");
    }

    const signedUrl = buildSignedWssUrl(singleUseToken);
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

    console.log("minted elevenlabs stt signed url", {
      roomId,
      identity,
      expiresAt,
    });

    const respBody: CreateElevenLabsSttSignedUrlResponse = {
      signedUrl,
      modelId: MODEL_ID,
      audioFormat: AUDIO_FORMAT,
      expiresAt,
    };
    return Response.json(respBody);
  } catch (err) {
    return respondError(err);
  }
}
