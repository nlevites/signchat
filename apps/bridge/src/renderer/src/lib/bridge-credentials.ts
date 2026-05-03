import type {
  CreateElevenLabsSignedUrlRequest,
  CreateElevenLabsSignedUrlResponse,
  CreateElevenLabsSttSignedUrlRequest,
  CreateElevenLabsSttSignedUrlResponse,
  CreateOpenRouterSessionKeyRequest,
  CreateOpenRouterSessionKeyResponse,
  ListElevenLabsVoicesResponse,
} from "@signchat/contracts";
import { log } from "@signchat/runtime-browser/logger";

/**
 * Bridge talks to the deployed Vercel mint endpoints the same way the web
 * app does, but with absolute URLs (no Next.js relative routing in
 * Electron) and a stable per-install identity so the OpenRouter session
 * keys carry attributable labels and the per-IP rate limits behave
 * predictably across launches.
 */

const DEFAULT_API_BASE = "https://signchat.org";

function getApiBase(): string {
  // electron-vite exposes import.meta.env in the renderer, but we keep
  // this defensive in case the env wasn't injected at build time. The
  // user can override with VITE_SIGNCHAT_API_BASE for local dev.
  const fromEnv =
    typeof import.meta !== "undefined" &&
    typeof import.meta.env !== "undefined"
      ? (import.meta.env as Record<string, string | undefined>)
          .VITE_SIGNCHAT_API_BASE
      : undefined;
  const trimmed = fromEnv?.trim();
  if (trimmed && trimmed.length > 0) return trimmed.replace(/\/$/, "");
  return DEFAULT_API_BASE;
}

const INSTALL_ID_KEY = "bridge:install-id";

/**
 * UUIDv4 persisted to localStorage. Used as both the synthetic `roomId`
 * and `identity` Bridge supplies to the mint endpoints — stable across
 * launches so the OpenRouter management API can attribute keys back to
 * a single installation.
 */
export function getOrCreateInstallId(): string {
  try {
    const existing = localStorage.getItem(INSTALL_ID_KEY);
    if (existing && /^[0-9a-fA-F-]{8,}$/.test(existing)) return existing;
    const fresh = generateUuid();
    localStorage.setItem(INSTALL_ID_KEY, fresh);
    return fresh;
  } catch {
    return generateUuid();
  }
}

function generateUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

class BridgeMintError extends Error {
  status: number;
  detail: string;
  constructor(message: string, status: number, detail: string) {
    super(message);
    this.name = "BridgeMintError";
    this.status = status;
    this.detail = detail;
  }
}

async function postJson<TReq, TRes>(
  path: string,
  body: TReq,
): Promise<TRes> {
  const url = `${getApiBase()}${path}`;
  const res = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = `${res.status} ${errBody.error}`;
    } catch {
      // not json — keep status-only detail
    }
    throw new BridgeMintError(`${path} failed: ${detail}`, res.status, detail);
  }
  return (await res.json()) as TRes;
}

async function getJson<TRes>(path: string): Promise<TRes> {
  const url = `${getApiBase()}${path}`;
  const res = await fetch(url, { method: "GET", cache: "no-store" });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = `${res.status} ${errBody.error}`;
    } catch {
      // not json
    }
    throw new BridgeMintError(`${path} failed: ${detail}`, res.status, detail);
  }
  return (await res.json()) as TRes;
}

interface BridgeIdentity {
  /** Synthetic roomId of the form `bridge-<install-uuid>`. */
  roomId: string;
  /** Same as roomId but without the `bridge-` prefix. */
  identity: string;
}

export function getBridgeIdentity(): BridgeIdentity {
  const installId = getOrCreateInstallId();
  return {
    roomId: `bridge-${installId}`.slice(0, 64),
    identity: installId.slice(0, 64),
  };
}

export async function mintOpenRouterSessionKey(): Promise<CreateOpenRouterSessionKeyResponse> {
  const id = getBridgeIdentity();
  const body: CreateOpenRouterSessionKeyRequest = {
    roomId: id.roomId,
    identity: id.identity,
    role: "deaf",
  };
  log.info("bridge-credentials", "minting OpenRouter session key", {
    roomId: id.roomId,
  });
  return postJson<CreateOpenRouterSessionKeyRequest, CreateOpenRouterSessionKeyResponse>(
    "/api/openrouter/session-key",
    body,
  );
}

export async function mintElevenLabsSignedUrl(
  voiceId?: string,
): Promise<CreateElevenLabsSignedUrlResponse> {
  const id = getBridgeIdentity();
  const body: CreateElevenLabsSignedUrlRequest = {
    roomId: id.roomId,
    identity: id.identity,
    role: "deaf",
    ...(voiceId ? { voiceId } : {}),
  };
  log.info("bridge-credentials", "minting ElevenLabs TTS URL", {
    roomId: id.roomId,
    voiceId: voiceId ?? "(default)",
  });
  return postJson<CreateElevenLabsSignedUrlRequest, CreateElevenLabsSignedUrlResponse>(
    "/api/elevenlabs/signed-url",
    body,
  );
}

export async function mintElevenLabsSttSignedUrl(): Promise<CreateElevenLabsSttSignedUrlResponse> {
  const id = getBridgeIdentity();
  const body: CreateElevenLabsSttSignedUrlRequest = {
    roomId: id.roomId,
    identity: id.identity,
    role: "deaf",
  };
  log.info("bridge-credentials", "minting ElevenLabs STT URL", {
    roomId: id.roomId,
  });
  return postJson<CreateElevenLabsSttSignedUrlRequest, CreateElevenLabsSttSignedUrlResponse>(
    "/api/elevenlabs/stt-signed-url",
    body,
  );
}

export async function listElevenLabsVoices(): Promise<ListElevenLabsVoicesResponse> {
  return getJson<ListElevenLabsVoicesResponse>("/api/elevenlabs/voices");
}

export { BridgeMintError };
