"use client";

import { useEffect, useRef, useState } from "react";
import { ConnectionState } from "livekit-client";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { useLatencyStats } from "@/lib/diagnostics/latency-markers";
import { useCredentials } from "@/lib/credentials/store";
import {
  RELIABILITY_BY_KIND,
  type ParticipantInfo,
  type RoomDataMessage,
  type RoomDataMessageKind,
} from "@/lib/contracts";
import {
  connectToRoom,
  type ConnectedRoom,
} from "@/lib/livekit/room-client";
import {
  publishLocalCameraAndMic,
  type PublishedLocalTracks,
} from "@/lib/livekit/local-tracks";
import {
  publishDataMessage,
  subscribeDataMessages,
} from "@/lib/livekit/data-channel";
import { RoomStore, useRoomState } from "@/lib/livekit/room-store";
import { RoomInbox, useRoomInbox } from "@/lib/livekit/inbox";
import { TrackTile } from "@/components/primitives/track-tile";

/**
 * Phase 2: LiveKit transport pane. Connects to the room minted in the
 * Lobby pane, publishes camera + mic, renders local + remote tiles, and
 * round-trips typed RoomDataMessages with the per-kind reliability
 * mandated by ARCHITECTURE.md §6.3 / §11.4.
 *
 * Two browser tabs / two browsers can join the same room id with distinct
 * identities and observe each other's streams + DataChannel here. Phase 4
 * will replace the Deaf-role mic publish with the §8 signchat-voice mixer.
 */

const SENDABLE_KINDS: RoomDataMessageKind[] = [
  "chat",
  "caption",
  "transcript_partial",
  "transcript_final",
];

const KIND_PALETTE: Record<RoomDataMessageKind, string> = {
  chat: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  caption: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200",
  transcript_partial:
    "border-amber-500/40 bg-amber-500/10 text-amber-200",
  transcript_final:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
};

const STATE_PALETTE: Record<ConnectionState, string> = {
  [ConnectionState.Connected]:
    "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  [ConnectionState.Connecting]:
    "border-amber-500/40 bg-amber-500/10 text-amber-200",
  [ConnectionState.Reconnecting]:
    "border-amber-500/40 bg-amber-500/10 text-amber-200",
  [ConnectionState.SignalReconnecting]:
    "border-amber-500/40 bg-amber-500/10 text-amber-200",
  [ConnectionState.Disconnected]:
    "border-slate-600 bg-slate-700/30 text-slate-300",
};

export function LiveKitPane() {
  const credentials = useCredentials();
  const roomState = useRoomState();
  const inbox = useRoomInbox();

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [composerKind, setComposerKind] = useState<RoomDataMessageKind>("chat");
  const [composerText, setComposerText] = useState<string>("");
  const [localTracksReady, setLocalTracksReady] = useState<boolean>(false);

  const connectedRoomRef = useRef<ConnectedRoom | null>(null);
  const localTracksRef = useRef<PublishedLocalTracks | null>(null);
  const unsubscribeDataRef = useRef<(() => void) | null>(null);

  const connectLatency = useLatencyStats("livekit.connect");
  const publishVideoLatency = useLatencyStats("livekit.publish.video");
  const publishAudioLatency = useLatencyStats("livekit.publish.audio");

  useEffect(() => {
    LogBus.debug("livekit", "livekit pane mounted");
  }, []);

  useEffect(() => {
    return () => {
      // Best-effort teardown on unmount. We can't await here, but the SDK
      // itself will tidy WebRTC resources when the page unloads.
      try {
        unsubscribeDataRef.current?.();
      } catch {
        // ignore
      }
      unsubscribeDataRef.current = null;
      const tracks = localTracksRef.current;
      localTracksRef.current = null;
      if (tracks) void tracks.unpublish();
      RoomStore.detach();
      const connected = connectedRoomRef.current;
      connectedRoomRef.current = null;
      if (connected) void connected.dispose();
    };
  }, []);

  async function teardown(): Promise<void> {
    try {
      unsubscribeDataRef.current?.();
    } catch {
      // ignore
    }
    unsubscribeDataRef.current = null;
    const tracks = localTracksRef.current;
    localTracksRef.current = null;
    setLocalTracksReady(false);
    if (tracks) {
      try {
        await tracks.unpublish();
      } catch {
        // ignore
      }
    }
    RoomStore.detach();
    const connected = connectedRoomRef.current;
    connectedRoomRef.current = null;
    if (connected) {
      try {
        await connected.dispose();
      } catch {
        // ignore
      }
    }
  }

  async function onConnect(): Promise<void> {
    if (!credentials.livekit || !credentials.context) return;
    setBusy(true);
    setError(null);
    const { context } = credentials;
    try {
      const connected = await connectToRoom({
        wsUrl: credentials.livekit.wsUrl,
        token: credentials.livekit.token,
        roomId: credentials.livekit.roomId,
        identity: credentials.livekit.identity,
        role: context.role,
      });
      connectedRoomRef.current = connected;
      RoomStore.attach(connected.room, context.role);

      const handler = (msg: RoomDataMessage, from: ParticipantInfo) => {
        RoomInbox.append(msg, from);
        LogBus.info("livekit", `recv ${msg.kind}`, {
          from: from.identity,
          id: "id" in msg ? msg.id : undefined,
        });
      };
      unsubscribeDataRef.current = subscribeDataMessages(
        connected.room,
        handler,
      );

      try {
        const tracks = await publishLocalCameraAndMic(connected.room);
        localTracksRef.current = tracks;
        setLocalTracksReady(true);
      } catch (err) {
        LogBus.error("livekit", "track publish failed", { error: errMsg(err) });
        setError(errMsg(err));
        // Stay connected — the user can retry publishing or send DataChannel
        // messages without a camera.
      }
    } catch (err) {
      LogBus.error("livekit", "connect failed", { error: errMsg(err) });
      setError(errMsg(err));
      await teardown();
    } finally {
      setBusy(false);
    }
  }

  async function onDisconnect(): Promise<void> {
    setBusy(true);
    try {
      await teardown();
      RoomInbox.clear();
    } finally {
      setBusy(false);
    }
  }

  async function onSend(): Promise<void> {
    if (!connectedRoomRef.current || !roomState.local) return;
    const trimmed = composerText.trim();
    if (!trimmed) return;
    const me: ParticipantInfo = {
      identity: roomState.local.identity,
      name: roomState.local.name,
      role: roomState.local.role ?? "deaf",
    };
    const id = newMsgId();
    const ts = Date.now();
    const msg = buildMessage({
      kind: composerKind,
      text: trimmed,
      from: me,
      id,
      ts,
    });
    try {
      await publishDataMessage(connectedRoomRef.current.room, msg);
      RoomInbox.append(msg, me);
      setComposerText("");
    } catch (err) {
      LogBus.error("livekit", "publishDataMessage failed", {
        error: errMsg(err),
      });
      setError(errMsg(err));
    }
  }

  const isConnected = roomState.state === ConnectionState.Connected;
  const stateLabel = roomState.state;
  const stateClass = STATE_PALETTE[roomState.state];
  const canConnect = Boolean(credentials.livekit && !busy && !isConnected);
  const canSend =
    isConnected && composerText.trim().length > 0 && !busy && roomState.local;

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold text-slate-100">
              LiveKit transport
            </h2>
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
              Phase 2 — live
            </span>
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${stateClass}`}
            >
              {stateLabel}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            {connectLatency ? (
              <span>
                connect p50 {Math.round(connectLatency.p50)}ms / p95{" "}
                {Math.round(connectLatency.p95)}ms
              </span>
            ) : null}
            {publishVideoLatency ? (
              <span>vid {Math.round(publishVideoLatency.last)}ms</span>
            ) : null}
            {publishAudioLatency ? (
              <span>aud {Math.round(publishAudioLatency.last)}ms</span>
            ) : null}
          </div>
        </div>
        {credentials.livekit && credentials.context ? (
          <p className="mb-4 text-sm text-slate-400">
            Connect to{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              {credentials.livekit.roomId}
            </code>{" "}
            as{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              {credentials.livekit.identity}
            </code>{" "}
            (
            <span className="text-slate-200">
              {credentials.livekit.role}
            </span>
            ). Open this URL in another tab with a different identity to make
            two participants.
          </p>
        ) : (
          <p className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            Mint a LiveKit token in the Lobby first.
          </p>
        )}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onConnect()}
            disabled={!canConnect}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Connect
          </button>
          <button
            type="button"
            onClick={() => void onDisconnect()}
            disabled={!isConnected || busy}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Disconnect
          </button>
          {error ? (
            <span className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
              {error}
            </span>
          ) : null}
          {isConnected && !localTracksReady ? (
            <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs text-amber-200">
              tracks not published — check camera permissions
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {roomState.local && roomState.room ? (
          <TrackTile
            participant={roomState.room.localParticipant}
            label={roomState.local.identity}
            role={roomState.local.role}
            mirrored
            mute
            isLocal
            rev={roomState.local.rev}
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-xs text-slate-500">
            Connect to publish your local camera + mic
          </div>
        )}
        {roomState.room && roomState.remotes.length > 0 ? (
          roomState.remotes.map((snap) => {
            const p = roomState.room!.remoteParticipants.get(snap.identity);
            if (!p) return null;
            return (
              <TrackTile
                key={snap.identity}
                participant={p}
                label={snap.identity}
                role={snap.role}
                rev={snap.rev}
              />
            );
          })
        ) : isConnected ? (
          <div className="flex aspect-video items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 text-xs text-slate-500">
            Waiting for a remote participant. Open another tab in the same
            room with a different identity.
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            DataChannel composer
          </h3>
          <span className="text-[11px] text-slate-500">
            reliable per kind from §6.3 (RELIABILITY_BY_KIND)
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={composerKind}
            onChange={(e) =>
              setComposerKind(e.target.value as RoomDataMessageKind)
            }
            className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-100"
            disabled={!isConnected}
          >
            {SENDABLE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k} {RELIABILITY_BY_KIND[k] ? "(reliable)" : "(lossy)"}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={composerText}
            onChange={(e) => setComposerText(e.target.value)}
            placeholder={kindPlaceholder(composerKind)}
            disabled={!isConnected}
            className="min-w-[280px] grow rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-40"
            onKeyDown={(e) => {
              if (e.key === "Enter" && canSend) {
                e.preventDefault();
                void onSend();
              }
            }}
          />
          <button
            type="button"
            onClick={() => void onSend()}
            disabled={!canSend}
            className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Send
          </button>
        </div>
        <p className="mt-2 text-[11px] text-slate-500">
          {composerKind === "caption"
            ? "Sends a contract-shaped caption with playAtMs=Date.now() and confidence=high. Phase 6 will populate this with real values aligned to TTS first audible."
            : "Sends a chat-shaped payload with the typed `text` field."}
        </p>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            Inbox tail{" "}
            <span className="ml-1 text-[11px] font-normal text-slate-500">
              {inbox.length} message{inbox.length === 1 ? "" : "s"}
            </span>
          </h3>
          <button
            type="button"
            onClick={() => RoomInbox.clear()}
            className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Clear
          </button>
        </div>
        {inbox.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
            No messages yet. Once both tabs have connected, send a chat /
            caption / transcript from either side to see it here.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {inbox
              .slice(-50)
              .reverse()
              .map((entry) => (
                <li
                  key={entry.id}
                  className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1.5 text-xs"
                >
                  <span
                    className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                      KIND_PALETTE[entry.msg.kind]
                    }`}
                  >
                    {entry.msg.kind}
                  </span>
                  <span className="w-32 shrink-0 truncate font-mono text-slate-300">
                    {entry.from.identity}
                  </span>
                  <span className="grow truncate font-mono text-slate-100">
                    {previewMessage(entry.msg)}
                  </span>
                  <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                    {formatRelMs(entry.receivedAtWall)}
                  </span>
                </li>
              ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function buildMessage(args: {
  kind: RoomDataMessageKind;
  text: string;
  from: ParticipantInfo;
  id: string;
  ts: number;
}): RoomDataMessage {
  const { kind, text, from, id, ts } = args;
  switch (kind) {
    case "chat":
      return { v: 1, kind, id, ts, from, text };
    case "transcript_partial":
      return { v: 1, kind, id, ts, from, text };
    case "transcript_final":
      return { v: 1, kind, id, ts, from, text };
    case "caption":
      return {
        v: 1,
        kind,
        id,
        ts,
        from,
        playAtMs: Date.now(),
        sentence: text,
        confidence: "high",
        usedSigns: [],
        modelId: "(workbench)",
        latencyMs: 0,
      };
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      throw new Error(`unknown kind: ${String(kind)}`);
    }
  }
}

function previewMessage(msg: RoomDataMessage): string {
  switch (msg.kind) {
    case "chat":
    case "transcript_partial":
    case "transcript_final":
      return msg.text;
    case "caption":
      return msg.sentence;
    default: {
      const _exhaustive: never = msg;
      void _exhaustive;
      return "";
    }
  }
}

function kindPlaceholder(kind: RoomDataMessageKind): string {
  switch (kind) {
    case "chat":
      return "type a chat message";
    case "caption":
      return "fake reconstructed sentence";
    case "transcript_partial":
      return "partial Whisper transcript";
    case "transcript_final":
      return "final Whisper transcript";
    default: {
      const _exhaustive: never = kind;
      void _exhaustive;
      return "";
    }
  }
}

function newMsgId(): string {
  return `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatRelMs(ts: number): string {
  const ms = Date.now() - ts;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
