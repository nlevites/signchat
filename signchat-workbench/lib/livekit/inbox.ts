"use client";

import { useSyncExternalStore } from "react";
import type { ParticipantInfo, RoomDataMessage } from "@/lib/contracts";

/**
 * In-memory tail of decoded `RoomDataMessage`s the local participant has
 * received over the LiveKit DataChannel. The LiveKit pane renders this tail;
 * Phase 6 will additionally route caption/transcript messages into the
 * Transcript strip from here.
 *
 * Single-room workbench → singleton store. Same useSyncExternalStore +
 * cached-snapshot pattern as LogBus / LatencyStore / CredentialStore.
 */

export interface InboxEntry {
  /** Monotonic, assigned by the inbox. */
  id: number;
  /** performance.now() at receive — used for relative-time rendering. */
  receivedAt: number;
  /** Wall-clock ms at receive — used for absolute time rendering. */
  receivedAtWall: number;
  msg: RoomDataMessage;
  from: ParticipantInfo;
}

const RING_SIZE = 200;
const EMPTY: readonly InboxEntry[] = [];

class RoomInboxImpl {
  private nextId = 1;
  private ring: InboxEntry[] = [];
  private cached: readonly InboxEntry[] = EMPTY;
  private subs = new Set<() => void>();

  append(msg: RoomDataMessage, from: ParticipantInfo): void {
    const entry: InboxEntry = {
      id: this.nextId++,
      receivedAt: performance.now(),
      receivedAtWall: Date.now(),
      msg,
      from,
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.cached = this.ring.slice();
    this.notify();
  }

  clear(): void {
    this.ring = [];
    this.cached = EMPTY;
    this.notify();
  }

  snapshot(): readonly InboxEntry[] {
    return this.cached;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
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

export const RoomInbox = new RoomInboxImpl();

const subscribeInbox = (cb: () => void) => RoomInbox.subscribe(cb);
const getInboxSnapshot = () => RoomInbox.snapshot();
const getServerInboxSnapshot = () => EMPTY;

export function useRoomInbox(): readonly InboxEntry[] {
  return useSyncExternalStore(
    subscribeInbox,
    getInboxSnapshot,
    getServerInboxSnapshot,
  );
}
