"use client";

import {
  type RemoteParticipant,
  type Room,
  RoomEvent,
} from "livekit-client";
import {
  isRoomDataMessage,
  RELIABILITY_BY_KIND,
  type ParticipantInfo,
  type Role,
  type RoomDataMessage,
} from "@signchat/contracts";
import { LogBus } from "@/lib/diagnostics/log-bus";

const textEncoder =
  typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
const textDecoder =
  typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

export async function publishRoomDataMessage(
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
    id: msg.id,
  });
}

export type DataMessageHandler = (
  msg: RoomDataMessage,
  from: ParticipantInfo,
) => void;

export function subscribeRoomDataMessages(
  room: Room,
  handler: DataMessageHandler,
): () => void {
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
      LogBus.warn("livekit", "DataReceived: invalid JSON", {
        bytes: payload.byteLength,
        from: participant?.identity ?? "(unknown)",
        topic,
        error: err instanceof Error ? err.message : "parse error",
      });
      return;
    }
    if (!isRoomDataMessage(parsed)) {
      LogBus.warn("livekit", "DataReceived: contract violation", {
        from: participant?.identity ?? "(unknown)",
        topic,
        preview: previewJson(parsed),
      });
      return;
    }
    const msg = parsed;
    if (topic && topic !== msg.kind) {
      // topic mismatch is suspicious but not catastrophic — log and accept
      LogBus.debug("livekit", "DataReceived: topic != kind", {
        topic,
        kind: msg.kind,
      });
    }
    handler(msg, msg.from ?? deriveSenderInfo(participant));
  };
  room.on(RoomEvent.DataReceived, onData);
  return () => {
    room.off(RoomEvent.DataReceived, onData);
  };
}

// fallback used when a sender omits `from`. pulls role from livekit metadata
// (set server-side in the token route) and falls back to "hearing" only as a
// final defensive default — every well-formed message embeds `from`.
function deriveSenderInfo(p?: RemoteParticipant): ParticipantInfo {
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
