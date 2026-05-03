"use client";

import {
  type RemoteParticipant,
  type Room,
  RoomEvent,
} from "livekit-client";
import {
  RELIABILITY_BY_KIND,
  type ParticipantInfo,
  type RoomDataMessage,
  type RoomDataMessageKind,
  type Role,
} from "@/lib/contracts";
import { LogBus } from "@/lib/diagnostics/log-bus";

/**
 * Typed publish + subscribe for `RoomDataMessage` over the LiveKit
 * DataChannel. Reliability per kind is read straight from the contract
 * (`RELIABILITY_BY_KIND` in lib/contracts) so no booleans get inlined at
 * call sites — change the contract once and every send/receive picks it up.
 *
 * On receive, malformed payloads are dropped with a warn-level LogBus entry
 * rather than thrown, since the room is shared and a malicious participant
 * shouldn't be able to crash the pane just by publishing junk bytes.
 */

const VALID_KINDS: ReadonlySet<RoomDataMessageKind> = new Set([
  "chat",
  "caption",
  "transcript_partial",
  "transcript_final",
]);

const VALID_ROLES: ReadonlySet<Role> = new Set(["deaf", "hearing"]);

const textEncoder =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const textDecoder =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

export async function publishDataMessage(
  room: Room,
  msg: RoomDataMessage,
): Promise<void> {
  if (!textEncoder) {
    throw new Error("TextEncoder is not available in this environment");
  }
  const reliable = RELIABILITY_BY_KIND[msg.kind];
  const payload = textEncoder.encode(JSON.stringify(msg));
  await room.localParticipant.publishData(payload, {
    reliable,
    topic: msg.kind,
  });
  LogBus.debug("livekit", `sent ${msg.kind}`, {
    bytes: payload.byteLength,
    reliable,
    id: "id" in msg ? msg.id : undefined,
  });
}

export type DataMessageHandler = (
  msg: RoomDataMessage,
  from: ParticipantInfo,
) => void;

export interface SubscribeOptions {
  /**
   * If true, malformed payloads still get a payload-truncated debug log so
   * an operator can diagnose contract drift. Defaults to true.
   */
  logMalformed?: boolean;
}

export function subscribeDataMessages(
  room: Room,
  handler: DataMessageHandler,
  options: SubscribeOptions = {},
): () => void {
  const logMalformed = options.logMalformed ?? true;
  if (!textDecoder) {
    throw new Error("TextDecoder is not available in this environment");
  }
  const onData = (
    payload: Uint8Array,
    participant?: RemoteParticipant,
    _kind?: unknown,
    topic?: string,
  ) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(textDecoder.decode(payload));
    } catch (err) {
      if (logMalformed) {
        LogBus.warn("livekit", "DataReceived: invalid JSON", {
          bytes: payload.byteLength,
          from: participant?.identity ?? "(unknown)",
          topic,
          error: err instanceof Error ? err.message : "parse error",
        });
      }
      return;
    }
    if (!isValidRoomDataMessage(parsed)) {
      if (logMalformed) {
        LogBus.warn("livekit", "DataReceived: contract violation", {
          from: participant?.identity ?? "(unknown)",
          topic,
          preview: previewJson(parsed),
        });
      }
      return;
    }
    const msg = parsed;
    if (topic && topic !== msg.kind) {
      // Topic mismatch is suspicious but not catastrophic — log and accept.
      LogBus.debug("livekit", "DataReceived: topic != kind", {
        topic,
        kind: msg.kind,
      });
    }
    const from: ParticipantInfo = msg.from ?? deriveSenderInfo(participant);
    handler(msg, from);
  };
  room.on(RoomEvent.DataReceived, onData);
  return () => {
    room.off(RoomEvent.DataReceived, onData);
  };
}

function isValidRoomDataMessage(value: unknown): value is RoomDataMessage {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  if (o.v !== 1) return false;
  if (typeof o.kind !== "string") return false;
  if (!VALID_KINDS.has(o.kind as RoomDataMessageKind)) return false;
  if (typeof o.id !== "string" || o.id.length === 0) return false;
  if (typeof o.ts !== "number" || !Number.isFinite(o.ts)) return false;
  if (!isValidParticipantInfo(o.from)) return false;
  switch (o.kind) {
    case "chat":
    case "transcript_partial":
    case "transcript_final":
      return typeof o.text === "string";
    case "caption":
      return (
        typeof o.sentence === "string" &&
        typeof o.playAtMs === "number" &&
        Number.isFinite(o.playAtMs) &&
        (o.confidence === "high" ||
          o.confidence === "medium" ||
          o.confidence === "low") &&
        Array.isArray(o.usedSigns) &&
        o.usedSigns.every((s) => typeof s === "string") &&
        typeof o.modelId === "string" &&
        typeof o.latencyMs === "number" &&
        Number.isFinite(o.latencyMs)
      );
    default:
      return false;
  }
}

function isValidParticipantInfo(value: unknown): value is ParticipantInfo {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.identity === "string" &&
    typeof o.name === "string" &&
    typeof o.role === "string" &&
    VALID_ROLES.has(o.role as Role)
  );
}

function deriveSenderInfo(p?: RemoteParticipant): ParticipantInfo {
  // Fallback for receivers when the sender forgot to embed `from`. We pull
  // role from the participant's metadata if available (we set that in
  // room-client.ts after connect), otherwise mark as hearing as a safe
  // default — Deaf-role flow always populates `from`.
  let role: Role = "hearing";
  if (p?.metadata) {
    try {
      const parsed = JSON.parse(p.metadata) as { role?: unknown };
      if (parsed.role === "deaf" || parsed.role === "hearing") {
        role = parsed.role;
      }
    } catch {
      // ignore malformed metadata
    }
  }
  return {
    identity: p?.identity ?? "(unknown)",
    name: p?.name ?? p?.identity ?? "(unknown)",
    role,
  };
}

function previewJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(value);
  }
}
