import type { ParticipantInfo } from "./participant";

export type RoomDataMessage =
  | {
      v: 1;
      kind: "chat";
      id: string;
      ts: number;
      from: ParticipantInfo;
      text: string;
    }
  | {
      v: 1;
      kind: "caption";
      id: string;
      ts: number;
      playAtMs: number;
      from: ParticipantInfo;
      sentence: string;
      confidence: "high" | "medium" | "low";
      usedSigns: string[];
      modelId: string;
      latencyMs: number;
    }
  | {
      v: 1;
      kind: "transcript_partial";
      id: string;
      ts: number;
      from: ParticipantInfo;
      text: string;
    }
  | {
      v: 1;
      kind: "transcript_final";
      id: string;
      ts: number;
      from: ParticipantInfo;
      text: string;
    };

const ROOM_DATA_KINDS = new Set([
  "chat",
  "caption",
  "transcript_partial",
  "transcript_final",
]);

export function isRoomDataMessage(x: unknown): x is RoomDataMessage {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    m.v === 1 &&
    typeof m.kind === "string" &&
    ROOM_DATA_KINDS.has(m.kind) &&
    typeof m.id === "string" &&
    typeof m.ts === "number" &&
    typeof m.from === "object" &&
    m.from !== null
  );
}
