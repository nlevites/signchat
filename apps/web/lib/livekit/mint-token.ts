import type { LiveKitTokenResponse, Role } from "@signchat/contracts";

export interface MintTokenArgs {
  roomId: string;
  identity: string;
  name: string;
  role: Role;
}

export interface MintedCredentials {
  wsUrl: string;
  token: string;
  tokenExpiresAt: number;
  identity: string;
  name: string;
  role: Role;
}

export class LiveKitTokenError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LiveKitTokenError";
    this.status = status;
  }
}

export async function mintLiveKitToken(args: MintTokenArgs): Promise<MintedCredentials> {
  const params = new URLSearchParams({
    room: args.roomId,
    identity: args.identity,
    name: args.name,
    role: args.role,
  });
  const res = await fetch(`/api/livekit/token?${params.toString()}`, {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = `${res.status} ${body.error}`;
    } catch {
      // body wasn't json — keep the status-only detail
    }
    throw new LiveKitTokenError(`token mint failed: ${detail}`, res.status);
  }
  const body = (await res.json()) as LiveKitTokenResponse;
  return {
    wsUrl: body.wsUrl,
    token: body.token,
    tokenExpiresAt: decodeJwtExpMs(body.token),
    identity: body.identity,
    name: body.name,
    role: body.role,
  };
}

// decode the jwt payload to extract `exp` (seconds since epoch) — no signature
// verification, this is just for ui countdown / stale-token detection.
function decodeJwtExpMs(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw new LiveKitTokenError("token payload missing", 0);
  const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
  const claims = JSON.parse(json) as { exp?: number };
  if (typeof claims.exp !== "number") {
    throw new LiveKitTokenError("token missing exp claim", 0);
  }
  return claims.exp * 1000;
}
