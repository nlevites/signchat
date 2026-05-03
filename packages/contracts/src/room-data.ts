import type { ParticipantInfo } from "./participant";
import type { ReconstructionConfidence } from "./confidence";

export interface ChatMessage {
  v: 1;
  kind: "chat";
  id: string;
  ts: number;
  from: ParticipantInfo;
  text: string;
}

export interface CaptionMessage {
  v: 1;
  kind: "caption";
  id: string;
  ts: number;
  playAtMs: number;
  from: ParticipantInfo;
  sentence: string;
  confidence: ReconstructionConfidence;
  usedSigns: string[];
  modelId: string;
  latencyMs: number;
}

export interface TranscriptPartialMessage {
  v: 1;
  kind: "transcript_partial";
  id: string;
  ts: number;
  from: ParticipantInfo;
  text: string;
}

export interface TranscriptFinalMessage {
  v: 1;
  kind: "transcript_final";
  id: string;
  ts: number;
  from: ParticipantInfo;
  text: string;
}

/* Debug-only frame snapshot from the deaf-side mediapipe + classifier
 * pipeline. lossy/unreliable: the receiver only renders the latest frame,
 * dropped frames are fine. opaque JSON so the contract package doesn't
 * need to depend on @signchat/runtime-browser types — both ends already
 * know the VisionFrame / ClassifierResult shapes. */
export interface DebugSignalsMessage {
  v: 1;
  kind: "debug_signals";
  id: string;
  ts: number;
  from: ParticipantInfo;
  frame: unknown;
  result: unknown;
}

export type RoomDataMessage =
  | ChatMessage
  | CaptionMessage
  | TranscriptPartialMessage
  | TranscriptFinalMessage
  | DebugSignalsMessage;

export type RoomDataMessageKind = RoomDataMessage["kind"];

const ROOM_DATA_KINDS: ReadonlySet<RoomDataMessageKind> = new Set([
  "chat",
  "caption",
  "transcript_partial",
  "transcript_final",
  "debug_signals",
]);

// reliability per kind, per architecture §11.4. encoded as a const map so the
// publish helper reads from the contract instead of inlining booleans at every
// call site.
export const RELIABILITY_BY_KIND: Record<RoomDataMessageKind, boolean> = {
  chat: true,
  caption: true,
  transcript_partial: false,
  transcript_final: true,
  debug_signals: false,
};

export function isRoomDataMessage(x: unknown): x is RoomDataMessage {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  if (m.v !== 1) return false;
  if (typeof m.kind !== "string") return false;
  if (!ROOM_DATA_KINDS.has(m.kind as RoomDataMessageKind)) return false;
  if (typeof m.id !== "string" || m.id.length === 0) return false;
  if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return false;
  if (!isParticipantInfo(m.from)) return false;
  switch (m.kind) {
    case "chat":
    case "transcript_partial":
    case "transcript_final":
      return typeof m.text === "string";
    case "caption":
      return (
        typeof m.sentence === "string" &&
        typeof m.playAtMs === "number" &&
        Number.isFinite(m.playAtMs) &&
        (m.confidence === "high" ||
          m.confidence === "medium" ||
          m.confidence === "low") &&
        Array.isArray(m.usedSigns) &&
        m.usedSigns.every((s) => typeof s === "string") &&
        typeof m.modelId === "string" &&
        typeof m.latencyMs === "number" &&
        Number.isFinite(m.latencyMs)
      );
    case "debug_signals":
      // frame/result are opaque to the contract — receiver casts back to
      // the runtime-browser shapes it already knows. presence is enough.
      return "frame" in m && "result" in m;
    default:
      return false;
  }
}

function isParticipantInfo(value: unknown): value is ParticipantInfo {
  if (!value || typeof value !== "object") return false;
  const o = value as Record<string, unknown>;
  return (
    typeof o.identity === "string" &&
    typeof o.name === "string" &&
    (o.role === "deaf" || o.role === "hearing")
  );
}
