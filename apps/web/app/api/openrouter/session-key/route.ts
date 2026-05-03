import crypto from "node:crypto";
import type {
  CreateOpenRouterSessionKeyRequest,
  CreateOpenRouterSessionKeyResponse,
} from "@signchat/contracts";
import {
  BadRequest,
  Forbidden,
  respondError,
  sanitizeIdentity,
  sanitizeRoomId,
} from "@/lib/api/sanitize";
import { enforceRateLimit } from "@/lib/api/rate-limit";

export const dynamic = "force-dynamic";

// 5 credits ≈ 100-200 reconstruction turns at $0.025-$0.05/turn worst case
// for google/gemini-3-flash-preview (~$0.30/M input, $2.50/M output).
const SESSION_KEY_LIMIT_CREDITS = 5;
const DEFAULT_MODEL_ID = "google/gemini-3-flash-preview" as const;

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

    const { roomId: rawRoomId, identity: rawIdentity, role } =
      body as Partial<CreateOpenRouterSessionKeyRequest>;

    const roomId = sanitizeRoomId(rawRoomId);
    const identity = sanitizeIdentity(rawIdentity);
    if (role !== "deaf") throw new Forbidden("deaf_only");

    enforceRateLimit(getClientIp(req), roomId);

    const managementKey = readEnv("OPENROUTER_MANAGEMENT_API_KEY");
    const createdAtMs = Date.now();
    const label = `signchat:${roomId}:${identity}:${Math.floor(createdAtMs / 1000)}`;

    const orRes = await fetch("https://openrouter.ai/api/v1/keys", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: label,
        limit: SESSION_KEY_LIMIT_CREDITS,
      }),
    });

    if (!orRes.ok) {
      const text = await orRes.text().catch(() => "");
      console.error("openrouter mint failed", orRes.status, text);
      throw new Error("openrouter_mint_failed");
    }

    const orJson = (await orRes.json()) as {
      data?: { key?: string };
      key?: string;
    };
    const apiKey = orJson.data?.key ?? orJson.key;
    if (typeof apiKey !== "string" || apiKey.length === 0) {
      throw new Error("openrouter_mint_no_key");
    }

    const keyHash = crypto
      .createHash("sha256")
      .update(apiKey)
      .digest("hex")
      .slice(0, 8);
    const createdAt = new Date(createdAtMs).toISOString();

    console.log("minted openrouter session key", {
      keyHash,
      roomId,
      identity,
      label,
      createdAt,
    });

    const respBody: CreateOpenRouterSessionKeyResponse = {
      apiKey,
      keyHash,
      label,
      limitCredits: SESSION_KEY_LIMIT_CREDITS,
      modelId: DEFAULT_MODEL_ID,
      createdAt,
    };
    return Response.json(respBody);
  } catch (err) {
    return respondError(err);
  }
}
