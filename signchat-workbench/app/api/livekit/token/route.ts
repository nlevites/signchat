import "server-only";

import { AccessToken } from "livekit-server-sdk";
import type { MintLiveKitTokenResponse, Role } from "@/lib/contracts";
import { ServerEnv } from "@/app/api/_helpers/env";
import { sanitizeIdentity, sanitizeRoom } from "@/app/api/_helpers/sanitize";
import { consumeToken, getClientIp } from "@/app/api/_helpers/rate-limit";
import { errorJson } from "@/app/api/_helpers/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/livekit/token
 *
 * Mints a 1-hour LiveKit JWT bound to one room + one participant.
 * Per ARCHITECTURE.md s10.1.
 *
 *   ?room=<sanitized>
 *   ?identity=<sanitized>
 *   ?name=<optional, defaults to identity>
 *   ?role=deaf|hearing
 *
 * Returns MintLiveKitTokenResponse JSON or { error } on failure.
 */
export async function GET(request: Request): Promise<Response> {
  const ip = getClientIp(request);
  if (!consumeToken("livekit-token", ip)) {
    return errorJson("rate_limited", 429);
  }
  try {
    const { searchParams } = new URL(request.url);
    const room = sanitizeRoom(searchParams.get("room"));
    const identity = sanitizeIdentity(searchParams.get("identity"));
    const nameRaw = searchParams.get("name")?.trim();
    const name = nameRaw && nameRaw.length > 0 ? nameRaw : identity;
    const roleRaw = searchParams.get("role") ?? "";
    if (roleRaw !== "deaf" && roleRaw !== "hearing") {
      return errorJson(`invalid role: "${roleRaw}"`, 400);
    }
    const role: Role = roleRaw;

    const env = ServerEnv.livekit();
    const at = new AccessToken(env.apiKey, env.apiSecret, {
      identity,
      name,
      ttl: "1h",
    });
    at.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    const token = await at.toJwt();

    const body: MintLiveKitTokenResponse = {
      token,
      wsUrl: env.url,
      roomId: room,
      identity,
      name,
      role,
    };
    console.info(
      `[livekit/token] room=${room} identity=${identity} role=${role}`,
    );
    return Response.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : "internal error";
    console.warn(`[livekit/token] error: ${message}`);
    return errorJson(message, 400);
  }
}
