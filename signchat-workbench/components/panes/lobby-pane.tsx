"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { CredentialStore, useCredentials } from "@/lib/credentials/store";
import {
  mintElevenLabsSignedUrl,
  mintLiveKitToken,
  mintOpenRouterSessionKey,
} from "@/lib/credentials/mint-clients";
import type { Role } from "@/lib/contracts";
import {
  CredentialCard,
  type CredentialStatus,
} from "@/components/primitives/credential-card";

const ID_RE = /^[a-zA-Z0-9_\- ]{1,64}$/;

interface MintState {
  status: CredentialStatus;
  latencyMs: number | null;
  error: string | null;
}

const idleState: MintState = { status: "idle", latencyMs: null, error: null };

export function LobbyPane() {
  const [role, setRole] = useState<Role>("deaf");
  const [room, setRoom] = useState<string>(() => `wb-${randomSuffix(5)}`);
  const [identity, setIdentity] = useState<string>(() => `${role}-${randomSuffix(3)}`);

  const [livekitState, setLivekitState] = useState<MintState>(idleState);
  const [openrouterState, setOpenrouterState] = useState<MintState>(idleState);
  const [elevenlabsState, setElevenlabsState] = useState<MintState>(idleState);

  const credentials = useCredentials();

  useEffect(() => {
    LogBus.debug("lobby", "lobby pane mounted");
  }, []);

  const roomValid = ID_RE.test(room.trim());
  const identityValid = ID_RE.test(identity.trim());
  const formValid = roomValid && identityValid;

  // When role flips, regenerate identity to match (only if user hasn't typed
  // a custom one yet — heuristic: starts with the previous role prefix).
  const onRoleChange = useCallback(
    (next: Role) => {
      setRole(next);
      setIdentity((prev) => {
        if (
          prev === "" ||
          prev.startsWith("deaf-") ||
          prev.startsWith("hearing-")
        ) {
          return `${next}-${randomSuffix(3)}`;
        }
        return prev;
      });
    },
    [],
  );

  const mintAll = useCallback(async () => {
    if (!formValid) return;

    const sanitizedRoom = room.trim();
    const sanitizedIdentity = identity.trim();

    CredentialStore.setContext({
      roomId: sanitizedRoom,
      identity: sanitizedIdentity,
      role,
    });

    LogBus.info("lobby", "minting credentials", {
      role,
      room: sanitizedRoom,
      identity: sanitizedIdentity,
    });

    const livekitPromise = (async () => {
      const t0 = performance.now();
      setLivekitState({ status: "minting", latencyMs: null, error: null });
      try {
        const result = await mintLiveKitToken({
          room: sanitizedRoom,
          identity: sanitizedIdentity,
          role,
        });
        CredentialStore.setLiveKit(result);
        setLivekitState({
          status: "ok",
          latencyMs: performance.now() - t0,
          error: null,
        });
      } catch (err) {
        setLivekitState({
          status: "failed",
          latencyMs: performance.now() - t0,
          error: errMsg(err),
        });
      }
    })();

    const openrouterPromise = (async () => {
      if (role !== "deaf") {
        setOpenrouterState({ status: "skipped", latencyMs: null, error: null });
        return;
      }
      const t0 = performance.now();
      setOpenrouterState({ status: "minting", latencyMs: null, error: null });
      try {
        const result = await mintOpenRouterSessionKey({
          roomId: sanitizedRoom,
          identity: sanitizedIdentity,
        });
        CredentialStore.setOpenRouter(result);
        setOpenrouterState({
          status: "ok",
          latencyMs: performance.now() - t0,
          error: null,
        });
      } catch (err) {
        setOpenrouterState({
          status: "failed",
          latencyMs: performance.now() - t0,
          error: errMsg(err),
        });
      }
    })();

    const elevenlabsPromise = (async () => {
      if (role !== "deaf") {
        setElevenlabsState({ status: "skipped", latencyMs: null, error: null });
        return;
      }
      const t0 = performance.now();
      setElevenlabsState({ status: "minting", latencyMs: null, error: null });
      try {
        const result = await mintElevenLabsSignedUrl({
          roomId: sanitizedRoom,
          identity: sanitizedIdentity,
        });
        CredentialStore.setElevenLabs(result);
        setElevenlabsState({
          status: "ok",
          latencyMs: performance.now() - t0,
          error: null,
        });
      } catch (err) {
        setElevenlabsState({
          status: "failed",
          latencyMs: performance.now() - t0,
          error: errMsg(err),
        });
      }
    })();

    await Promise.all([livekitPromise, openrouterPromise, elevenlabsPromise]);
  }, [role, room, identity, formValid]);

  const allMinted = useMemo(() => {
    if (role === "hearing") {
      return livekitState.status === "ok";
    }
    return (
      livekitState.status === "ok" &&
      openrouterState.status === "ok" &&
      elevenlabsState.status === "ok"
    );
  }, [role, livekitState.status, openrouterState.status, elevenlabsState.status]);

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold text-slate-100">Lobby</h2>
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
              Phase 1 — live
            </span>
          </div>
          {allMinted ? (
            <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-sky-300">
              saved to credential store
            </span>
          ) : null}
        </div>
        <p className="mb-4 text-sm text-slate-400">
          Pick role + room id, mint all three Vercel-style credentials per
          ARCHITECTURE.md s10. Successful credentials are saved to the
          in-memory store and consumed by the LiveKit / OpenRouter /
          ElevenLabs panes.
        </p>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-400">role</label>
            <div className="flex rounded-md border border-slate-700 bg-slate-900 p-1 text-xs">
              {(["deaf", "hearing"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onRoleChange(option)}
                  className={[
                    "flex-1 rounded px-3 py-1.5 transition-colors",
                    role === option
                      ? "bg-sky-500/20 text-sky-100"
                      : "text-slate-400 hover:text-slate-200",
                  ].join(" ")}
                >
                  {option}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-400"
              htmlFor="lobby-room"
            >
              room id
            </label>
            <input
              id="lobby-room"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              className={`w-full rounded-md border bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500 ${
                roomValid ? "border-slate-700" : "border-rose-500/60"
              }`}
              placeholder="wb-xxxxx"
            />
            <p className="text-[10px] text-slate-500">[a-zA-Z0-9_- ]{"{1,64}"}</p>
          </div>
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-400"
              htmlFor="lobby-identity"
            >
              identity
            </label>
            <input
              id="lobby-identity"
              value={identity}
              onChange={(e) => setIdentity(e.target.value)}
              className={`w-full rounded-md border bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500 ${
                identityValid ? "border-slate-700" : "border-rose-500/60"
              }`}
              placeholder="deaf-xxx"
            />
            <p className="text-[10px] text-slate-500">[a-zA-Z0-9_- ]{"{1,64}"}</p>
          </div>
        </div>

        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void mintAll()}
            disabled={!formValid}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Mint all
          </button>
          <button
            type="button"
            onClick={() => {
              CredentialStore.clear();
              setLivekitState(idleState);
              setOpenrouterState(idleState);
              setElevenlabsState(idleState);
              LogBus.debug("lobby", "credentials cleared");
            }}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
          >
            Clear
          </button>
          {credentials.mintedAt ? (
            <span className="text-[11px] text-slate-500">
              last mint {formatRel(credentials.mintedAt)}
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <CredentialCard
          title="LiveKit JWT"
          endpoint="GET /api/livekit/token"
          status={livekitState.status}
          latencyMs={livekitState.latencyMs}
          errorMessage={livekitState.error}
          rows={
            credentials.livekit
              ? [
                  { label: "wsUrl", value: credentials.livekit.wsUrl },
                  { label: "roomId", value: credentials.livekit.roomId },
                  { label: "identity", value: credentials.livekit.identity },
                  { label: "role", value: credentials.livekit.role },
                  { label: "token", sensitiveValue: credentials.livekit.token },
                ]
              : []
          }
        />
        <CredentialCard
          title="OpenRouter session key"
          endpoint="POST /api/openrouter/session-key"
          status={openrouterState.status}
          latencyMs={openrouterState.latencyMs}
          errorMessage={openrouterState.error}
          skippedReason={
            role !== "deaf"
              ? "OpenRouter session keys are deaf-only (s10.2)."
              : null
          }
          rows={
            credentials.openrouter
              ? [
                  { label: "modelId", value: credentials.openrouter.modelId },
                  {
                    label: "limit (USD)",
                    value: credentials.openrouter.limitCredits.toFixed(2),
                  },
                  { label: "keyHash", value: credentials.openrouter.keyHash },
                  { label: "label", value: credentials.openrouter.label },
                  { label: "apiKey", sensitiveValue: credentials.openrouter.apiKey },
                ]
              : []
          }
        />
        <CredentialCard
          title="ElevenLabs signed URL"
          endpoint="POST /api/elevenlabs/signed-url"
          status={elevenlabsState.status}
          latencyMs={elevenlabsState.latencyMs}
          errorMessage={elevenlabsState.error}
          skippedReason={
            role !== "deaf"
              ? "ElevenLabs signed URLs are deaf-only (s10.3)."
              : null
          }
          rows={
            credentials.elevenlabs
              ? [
                  { label: "voiceId", value: credentials.elevenlabs.voiceId },
                  { label: "modelId", value: credentials.elevenlabs.modelId },
                  {
                    label: "outputFormat",
                    value: credentials.elevenlabs.outputFormat,
                  },
                  {
                    label: "expiresAt",
                    value: credentials.elevenlabs.expiresAt ?? "(unknown)",
                  },
                  {
                    label: "signedUrl",
                    sensitiveValue: credentials.elevenlabs.signedUrl,
                  },
                ]
              : []
          }
        />
      </div>
    </section>
  );
}

function randomSuffix(len: number): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}

function formatRel(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000) return `${ms}ms ago`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  return `${Math.round(ms / 60_000)}m ago`;
}
