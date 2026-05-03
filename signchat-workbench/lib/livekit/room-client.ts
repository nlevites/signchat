"use client";

import {
  type ConnectionQuality,
  type ConnectionState,
  type DisconnectReason,
  type LocalTrackPublication,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  type SubscriptionError,
} from "livekit-client";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";
import type { Role } from "@/lib/contracts";

/**
 * connectToRoom + dispose — the canonical entry-point the workbench LiveKit
 * pane uses to bring up a room. Wires every interesting Room event into the
 * LogBus under source="livekit" so the bottom-of-screen log stream tells the
 * full story of what livekit-client did, and marks `livekit.connect` so the
 * Latency tab populates the §13 publish budget row.
 *
 * Why `dispose()` instead of just exposing `room.disconnect()`?
 * - We attach a non-trivial set of listeners; the consumer should never have
 *   to remember the inverse.
 * - `room.disconnect()` is idempotent but our listeners need explicit removal
 *   to avoid orphaned closures holding references to the old room object
 *   when the user reconnects with a different identity.
 */

export interface ConnectArgs {
  wsUrl: string;
  token: string;
  /** Sanitized id used for log scoping. Must match the JWT's room. */
  roomId: string;
  /** Sanitized identity for log scoping. Must match the JWT's identity. */
  identity: string;
  /** "deaf" or "hearing"; carried as participant metadata for the remote tile. */
  role: Role;
  /** Optional override for the underlying livekit-client Room ctor. */
  roomOptions?: ConstructorParameters<typeof Room>[0];
}

export interface ConnectedRoom {
  room: Room;
  /** Removes all listeners and disconnects the room (best-effort). */
  dispose: () => Promise<void>;
}

export async function connectToRoom(args: ConnectArgs): Promise<ConnectedRoom> {
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    ...(args.roomOptions ?? {}),
  });

  // Carry the role across the wire so the remote tile can label it without
  // a separate handshake. ARCHITECTURE.md doesn't mandate this, but the
  // workbench needs it to render role chips on remote tiles.
  // setMetadata is server-authoritative, so this is only a hint to localParticipant
  // until the server echoes it back via ParticipantMetadataChanged.
  // (We set it after connect so the server accepts it.)

  const handlers = registerLogHandlers(room, args);

  const turnId = newTurnId();
  mark("livekit.connect", turnId, "start");

  try {
    LogBus.info("livekit", "connecting", {
      wsUrl: args.wsUrl,
      roomId: args.roomId,
      identity: args.identity,
      role: args.role,
    });
    await room.connect(args.wsUrl, args.token, { autoSubscribe: true });
    mark("livekit.connect", turnId, "end");
    LogBus.info("livekit", "connected", {
      roomId: args.roomId,
      identity: args.identity,
      role: args.role,
      remoteParticipants: room.remoteParticipants.size,
    });
    try {
      await room.localParticipant.setMetadata(JSON.stringify({ role: args.role }));
    } catch (err) {
      LogBus.debug("livekit", "setMetadata skipped", { reason: errMsg(err) });
    }
  } catch (err) {
    // mark `end` so the failed attempt is visible as a sample, then surface.
    mark("livekit.connect", turnId, "end");
    LogBus.error("livekit", "connect failed", { error: errMsg(err) });
    detachHandlers(room, handlers);
    try {
      await room.disconnect(true);
    } catch {
      // best-effort
    }
    throw err;
  }

  const dispose = async () => {
    LogBus.debug("livekit", "disposing room", {
      roomId: args.roomId,
      identity: args.identity,
    });
    detachHandlers(room, handlers);
    try {
      await room.disconnect(true);
    } catch (err) {
      LogBus.warn("livekit", "disconnect threw (ignored)", {
        error: errMsg(err),
      });
    }
  };

  return { room, dispose };
}

interface HandlerEntry {
  event: RoomEvent;
  fn: (...a: unknown[]) => void;
}

function registerLogHandlers(room: Room, args: ConnectArgs): HandlerEntry[] {
  const log = (
    level: "debug" | "info" | "warn" | "error",
    msg: string,
    payload?: unknown,
  ) => LogBus[level]("livekit", msg, payload);

  const onConnected = () => log("info", "RoomEvent.Connected");
  const onReconnecting = () => log("warn", "RoomEvent.Reconnecting");
  const onSignalReconnecting = () => log("debug", "RoomEvent.SignalReconnecting");
  const onReconnected = () => log("info", "RoomEvent.Reconnected");
  const onDisconnected = (reason?: DisconnectReason) =>
    log("info", "RoomEvent.Disconnected", { reason });
  const onConnectionStateChanged = (state: ConnectionState) =>
    log("debug", "RoomEvent.ConnectionStateChanged", { state });
  const onParticipantConnected = (p: RemoteParticipant) =>
    log("info", "ParticipantConnected", {
      identity: p.identity,
      sid: p.sid,
    });
  const onParticipantDisconnected = (p: RemoteParticipant) =>
    log("info", "ParticipantDisconnected", { identity: p.identity });
  const onTrackSubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    p: RemoteParticipant,
  ) =>
    log("debug", "TrackSubscribed", {
      identity: p.identity,
      kind: track.kind,
      source: publication.source,
      sid: publication.trackSid,
    });
  const onTrackUnsubscribed = (
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    p: RemoteParticipant,
  ) =>
    log("debug", "TrackUnsubscribed", {
      identity: p.identity,
      kind: track.kind,
      source: publication.source,
    });
  const onTrackSubscriptionFailed = (
    sid: string,
    p: RemoteParticipant,
    reason?: SubscriptionError,
  ) =>
    log("warn", "TrackSubscriptionFailed", {
      identity: p.identity,
      sid,
      reason,
    });
  const onLocalTrackPublished = (pub: LocalTrackPublication) =>
    log("debug", "LocalTrackPublished", {
      kind: pub.kind,
      source: pub.source,
      name: pub.trackName,
    });
  const onLocalTrackUnpublished = (pub: LocalTrackPublication) =>
    log("debug", "LocalTrackUnpublished", {
      kind: pub.kind,
      source: pub.source,
    });
  const onConnectionQualityChanged = (
    quality: ConnectionQuality,
    p: Participant,
  ) =>
    log("debug", "ConnectionQualityChanged", {
      identity: p.identity,
      quality,
    });
  const onMediaDevicesError = (err: Error, kind?: MediaDeviceKind) =>
    log("error", "MediaDevicesError", { error: err.message, kind });
  const onSignalConnected = () => log("debug", "SignalConnected");

  const entries: HandlerEntry[] = [
    { event: RoomEvent.Connected, fn: onConnected as never },
    { event: RoomEvent.Reconnecting, fn: onReconnecting as never },
    { event: RoomEvent.SignalReconnecting, fn: onSignalReconnecting as never },
    { event: RoomEvent.Reconnected, fn: onReconnected as never },
    { event: RoomEvent.Disconnected, fn: onDisconnected as never },
    {
      event: RoomEvent.ConnectionStateChanged,
      fn: onConnectionStateChanged as never,
    },
    { event: RoomEvent.ParticipantConnected, fn: onParticipantConnected as never },
    {
      event: RoomEvent.ParticipantDisconnected,
      fn: onParticipantDisconnected as never,
    },
    { event: RoomEvent.TrackSubscribed, fn: onTrackSubscribed as never },
    { event: RoomEvent.TrackUnsubscribed, fn: onTrackUnsubscribed as never },
    {
      event: RoomEvent.TrackSubscriptionFailed,
      fn: onTrackSubscriptionFailed as never,
    },
    { event: RoomEvent.LocalTrackPublished, fn: onLocalTrackPublished as never },
    {
      event: RoomEvent.LocalTrackUnpublished,
      fn: onLocalTrackUnpublished as never,
    },
    {
      event: RoomEvent.ConnectionQualityChanged,
      fn: onConnectionQualityChanged as never,
    },
    { event: RoomEvent.MediaDevicesError, fn: onMediaDevicesError as never },
    { event: RoomEvent.SignalConnected, fn: onSignalConnected as never },
  ];
  for (const { event, fn } of entries) {
    room.on(event, fn);
  }
  void args;
  return entries;
}

function detachHandlers(room: Room, entries: HandlerEntry[]): void {
  for (const { event, fn } of entries) {
    room.off(event, fn);
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
