import { AccessToken } from "livekit-server-sdk";
import type { LiveKitTokenResponse } from "@signchat/contracts";
import {
  sanitizeIdentity,
  sanitizeRoomId,
  sanitizeRole,
  respondError,
} from "@/lib/api/sanitize";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

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

export async function GET(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const roomId = sanitizeRoomId(url.searchParams.get("room"));
    const identity = sanitizeIdentity(url.searchParams.get("identity"));
    const role = sanitizeRole(url.searchParams.get("role"));
    const nameRaw = url.searchParams.get("name");
    const name =
      nameRaw && nameRaw.length > 0 ? sanitizeIdentity(nameRaw) : identity;

    enforceRateLimit(getClientIp(req), roomId);

    const wsUrl = readEnv("LIVEKIT_URL");
    const apiKey = readEnv("LIVEKIT_API_KEY");
    const apiSecret = readEnv("LIVEKIT_API_SECRET");

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name,
      ttl: "1h",
    });
    at.addGrant({
      roomJoin: true,
      room: roomId,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();

    const body: LiveKitTokenResponse = {
      token,
      wsUrl,
      roomId,
      identity,
      name,
      role,
    };
    return Response.json(body);
  } catch (err) {
    return respondError(err);
  }
}
