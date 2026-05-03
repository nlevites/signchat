"use client";

import type {
  MintElevenLabsSignedUrlResponse,
  MintErrorResponse,
  MintLiveKitTokenResponse,
  MintOpenRouterSessionKeyResponse,
  Role,
} from "@/lib/contracts";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";

/**
 * Typed fetch wrappers around the credential-mint routes. Each wrapper:
 *   - marks latency under `mint.<provider>` so the Latency tab populates
 *   - logs success / failure to the LogBus under `credentials`
 *   - throws on non-2xx with the server's error message
 */

export interface MintLiveKitArgs {
  room: string;
  identity: string;
  role: Role;
  name?: string;
}

export async function mintLiveKitToken(
  args: MintLiveKitArgs,
): Promise<MintLiveKitTokenResponse> {
  const probe = newTurnId();
  mark("mint.livekit", probe, "start");
  try {
    const url = new URL("/api/livekit/token", window.location.origin);
    url.searchParams.set("room", args.room);
    url.searchParams.set("identity", args.identity);
    url.searchParams.set("role", args.role);
    if (args.name) url.searchParams.set("name", args.name);
    const res = await fetch(url, { method: "GET", cache: "no-store" });
    if (!res.ok) {
      const err = (await safeJson(res)) as MintErrorResponse;
      throw new Error(err.error ?? `livekit/token ${res.status}`);
    }
    const json = (await res.json()) as MintLiveKitTokenResponse;
    LogBus.info("credentials", "minted livekit token", {
      room: json.roomId,
      identity: json.identity,
      role: json.role,
    });
    return json;
  } finally {
    mark("mint.livekit", probe, "end");
  }
}

export interface MintOpenRouterArgs {
  roomId: string;
  identity: string;
}

export async function mintOpenRouterSessionKey(
  args: MintOpenRouterArgs,
): Promise<MintOpenRouterSessionKeyResponse> {
  const probe = newTurnId();
  mark("mint.openrouter", probe, "start");
  try {
    const res = await fetch("/api/openrouter/session-key", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, role: "deaf" as const }),
    });
    if (!res.ok) {
      const err = (await safeJson(res)) as MintErrorResponse;
      throw new Error(err.error ?? `openrouter/session-key ${res.status}`);
    }
    const json = (await res.json()) as MintOpenRouterSessionKeyResponse;
    LogBus.info("credentials", "minted openrouter session key", {
      keyHash: json.keyHash,
      label: json.label,
      limitCredits: json.limitCredits,
    });
    return json;
  } finally {
    mark("mint.openrouter", probe, "end");
  }
}

export interface MintElevenLabsArgs {
  roomId: string;
  identity: string;
  voiceId?: string;
  modelId?: "eleven_flash_v2_5";
  outputFormat?: "pcm_24000";
}

export async function mintElevenLabsSignedUrl(
  args: MintElevenLabsArgs,
): Promise<MintElevenLabsSignedUrlResponse> {
  const probe = newTurnId();
  mark("mint.elevenlabs", probe, "start");
  try {
    const res = await fetch("/api/elevenlabs/signed-url", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...args, role: "deaf" as const }),
    });
    if (!res.ok) {
      const err = (await safeJson(res)) as MintErrorResponse;
      throw new Error(err.error ?? `elevenlabs/signed-url ${res.status}`);
    }
    const json = (await res.json()) as MintElevenLabsSignedUrlResponse;
    LogBus.info("credentials", "minted elevenlabs signed url", {
      voiceId: json.voiceId,
      expiresAt: json.expiresAt,
    });
    return json;
  } finally {
    mark("mint.elevenlabs", probe, "end");
  }
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
