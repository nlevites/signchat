"use client";

import { useSyncExternalStore } from "react";
import {
  ConnectionState,
  type ConnectionQuality,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type Room,
  RoomEvent,
  type TrackPublication,
} from "livekit-client";
import type { Role } from "@/lib/contracts";

/**
 * Reactive snapshot of the current LiveKit Room. The Room instance from
 * livekit-client mutates in place (`room.remoteParticipants` is a Map that
 * grows / shrinks); React needs an external-store hook to re-render when
 * remotes join / leave or when the connection state changes.
 *
 * Singleton because the workbench is single-room. Callers (the pane) hand
 * a connected Room to `RoomStore.attach(room)` and call `RoomStore.detach()`
 * before disposing the room.
 *
 * Mirrors the snapshot-cache pattern in lib/diagnostics/log-bus.ts so
 * useSyncExternalStore receives stable identities across consecutive
 * subscriber notifications without changes.
 */

export interface RemoteParticipantSnapshot {
  identity: string;
  name: string;
  sid: string;
  role: Role | null;
  /** Most recent ConnectionQuality value reported by the SDK. */
  quality: string;
  /** Bumped whenever the participant emits any state change we care about. */
  rev: number;
}

export interface LocalParticipantSnapshot {
  identity: string;
  name: string;
  role: Role | null;
  /** Bumped on any local track / metadata change. */
  rev: number;
}

export interface RoomSnapshot {
  /** The Room instance, exposed for callers that need to call SDK methods. */
  room: Room | null;
  state: ConnectionState;
  local: LocalParticipantSnapshot | null;
  remotes: ReadonlyArray<RemoteParticipantSnapshot>;
  /** Wall-clock ms when the room successfully connected. */
  connectedAt: number | null;
}

const EMPTY_REMOTES: ReadonlyArray<RemoteParticipantSnapshot> = [];

const EMPTY_SNAPSHOT: RoomSnapshot = {
  room: null,
  state: ConnectionState.Disconnected,
  local: null,
  remotes: EMPTY_REMOTES,
  connectedAt: null,
};

class RoomStoreImpl {
  private room: Room | null = null;
  private connectedAt: number | null = null;
  private detachListeners: (() => void) | null = null;
  private localRev = 0;
  private remoteRevs = new Map<string, number>();
  private cached: RoomSnapshot = EMPTY_SNAPSHOT;
  private subs = new Set<() => void>();

  attach(room: Room, role: Role): void {
    if (this.room === room) return;
    this.detach();
    this.room = room;
    this.connectedAt = Date.now();
    this.localRev = 1;
    this.remoteRevs.clear();
    for (const p of room.remoteParticipants.values()) {
      this.remoteRevs.set(p.identity, 1);
    }
    const onAny = () => {
      this.localRev += 1;
      this.refresh();
    };
    const onLocalChanged = () => {
      this.localRev += 1;
      this.refresh();
    };
    const bumpRemote = (p: Participant) => {
      const id = p.identity;
      this.remoteRevs.set(id, (this.remoteRevs.get(id) ?? 0) + 1);
      this.refresh();
    };
    const onTrackTriple = (
      _t: RemoteTrack,
      _pub: RemoteTrackPublication,
      p: RemoteParticipant,
    ) => bumpRemote(p);
    const onTrackPubPair = (
      _pub: RemoteTrackPublication,
      p: RemoteParticipant,
    ) => bumpRemote(p);
    const onTrackMutedPair = (_pub: TrackPublication, p: Participant) =>
      bumpRemote(p);
    const onConnectionQuality = (
      _q: ConnectionQuality,
      p: Participant,
    ) => bumpRemote(p);
    const onMetadataChanged = (
      _m: string | undefined,
      p: RemoteParticipant | { identity: string },
    ) => bumpRemote(p as Participant);
    const onParticipantConnected = (p: RemoteParticipant) => {
      this.remoteRevs.set(p.identity, 1);
      this.refresh();
    };
    const onParticipantDisconnected = (p: RemoteParticipant) => {
      this.remoteRevs.delete(p.identity);
      this.refresh();
    };
    room.on(RoomEvent.ConnectionStateChanged, onAny);
    room.on(RoomEvent.Reconnecting, onAny);
    room.on(RoomEvent.Reconnected, onAny);
    room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    room.on(RoomEvent.TrackSubscribed, onTrackTriple);
    room.on(RoomEvent.TrackUnsubscribed, onTrackTriple);
    room.on(RoomEvent.TrackPublished, onTrackPubPair);
    room.on(RoomEvent.TrackUnpublished, onTrackPubPair);
    room.on(RoomEvent.TrackMuted, onTrackMutedPair);
    room.on(RoomEvent.TrackUnmuted, onTrackMutedPair);
    room.on(RoomEvent.LocalTrackPublished, onLocalChanged);
    room.on(RoomEvent.LocalTrackUnpublished, onLocalChanged);
    room.on(RoomEvent.ConnectionQualityChanged, onConnectionQuality);
    room.on(RoomEvent.ParticipantMetadataChanged, onMetadataChanged);
    this.detachListeners = () => {
      room.off(RoomEvent.ConnectionStateChanged, onAny);
      room.off(RoomEvent.Reconnecting, onAny);
      room.off(RoomEvent.Reconnected, onAny);
      room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.off(RoomEvent.TrackSubscribed, onTrackTriple);
      room.off(RoomEvent.TrackUnsubscribed, onTrackTriple);
      room.off(RoomEvent.TrackPublished, onTrackPubPair);
      room.off(RoomEvent.TrackUnpublished, onTrackPubPair);
      room.off(RoomEvent.TrackMuted, onTrackMutedPair);
      room.off(RoomEvent.TrackUnmuted, onTrackMutedPair);
      room.off(RoomEvent.LocalTrackPublished, onLocalChanged);
      room.off(RoomEvent.LocalTrackUnpublished, onLocalChanged);
      room.off(RoomEvent.ConnectionQualityChanged, onConnectionQuality);
      room.off(RoomEvent.ParticipantMetadataChanged, onMetadataChanged);
    };
    this.localRole = role;
    this.refresh();
  }

  detach(): void {
    if (this.detachListeners) {
      try {
        this.detachListeners();
      } catch {
        // ignore
      }
      this.detachListeners = null;
    }
    this.room = null;
    this.connectedAt = null;
    this.localRev = 0;
    this.remoteRevs.clear();
    this.cached = EMPTY_SNAPSHOT;
    this.notify();
  }

  snapshot(): RoomSnapshot {
    return this.cached;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private localRole: Role | null = null;

  private refresh(): void {
    const room = this.room;
    if (!room) {
      this.cached = EMPTY_SNAPSHOT;
      this.notify();
      return;
    }
    const lp = room.localParticipant;
    const local: LocalParticipantSnapshot = {
      identity: lp.identity,
      name: lp.name ?? lp.identity,
      role: this.localRole,
      rev: this.localRev,
    };
    const remotes: RemoteParticipantSnapshot[] = [];
    for (const p of room.remoteParticipants.values()) {
      remotes.push({
        identity: p.identity,
        name: p.name ?? p.identity,
        sid: p.sid,
        role: parseRoleFromMetadata(p.metadata),
        quality: p.connectionQuality,
        rev: this.remoteRevs.get(p.identity) ?? 0,
      });
    }
    remotes.sort((a, b) => a.identity.localeCompare(b.identity));
    this.cached = {
      room,
      state: room.state,
      local,
      remotes,
      connectedAt: this.connectedAt,
    };
    this.notify();
  }

  private notify(): void {
    for (const sub of this.subs) {
      try {
        sub();
      } catch {
        // ignore
      }
    }
  }
}

function parseRoleFromMetadata(metadata?: string): Role | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { role?: unknown };
    if (parsed.role === "deaf" || parsed.role === "hearing") return parsed.role;
  } catch {
    // ignore
  }
  return null;
}

export const RoomStore = new RoomStoreImpl();

const subscribeRoom = (cb: () => void) => RoomStore.subscribe(cb);
const getRoomSnapshot = () => RoomStore.snapshot();
const getServerRoomSnapshot = () => EMPTY_SNAPSHOT;

export function useRoomState(): RoomSnapshot {
  return useSyncExternalStore(
    subscribeRoom,
    getRoomSnapshot,
    getServerRoomSnapshot,
  );
}
