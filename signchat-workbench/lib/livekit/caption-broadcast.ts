"use client";

import type { Room } from "livekit-client";
import type {
  CaptionMessage,
  ParticipantInfo,
  ReconstructionConfidence,
} from "@/lib/contracts";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { publishDataMessage } from "./data-channel";

/**
 * Phase 6: broadcast a §11.4 `caption` DataChannel message at the instant
 * the §8.1 mixer schedules the first audible sample of a TTS turn.
 *
 * `playAtMs` is the wall-clock projection of the AudioContext-relative
 * `firstAudibleAt` value the Phase 4 mixer returns (`scheduleTtsChunk`'s
 * `startedAt`). Per ARCHITECTURE.md §6.2 this lets the Hearing tab render
 * the caption in lock-step with the audible byte even though SFU
 * propagation adds ~100 ms of jitter.
 *
 * Caller obtains `from` from the connected room's local participant. We
 * keep the full sentence + confidence + usedSigns + modelId + latencyMs
 * inside the payload so a tab joining mid-turn doesn't have to round-trip
 * through OpenRouter again — the §11.4 contract already encodes this.
 */

export interface BroadcastCaptionArgs {
  room: Room;
  audioCtx: AudioContext;
  /** Mixer's `scheduleTtsChunk(...).startedAt` — audioCtx absolute seconds. */
  firstAudibleAt: number;
  from: ParticipantInfo;
  sentence: string;
  confidence: ReconstructionConfidence;
  usedSigns: string[];
  modelId: string;
  latencyMs: number;
  /** Stable id for this turn. Defaults to a time-derived string. */
  turnId?: string;
}

export async function broadcastCaption(args: BroadcastCaptionArgs): Promise<void> {
  const ts = Date.now();
  const audioCtxNow = args.audioCtx.currentTime;
  // Project audioCtx-relative seconds into wall-clock ms. Clamp to >= ts
  // because (a) the SFU adds ~100 ms minimum, so any slightly-in-the-past
  // value is cosmetic and (b) we never want a Hearing-side renderer
  // computing a negative wait.
  const projectedMs = ts + Math.max(0, args.firstAudibleAt - audioCtxNow) * 1000;
  const playAtMs = Math.max(ts, projectedMs);

  const id = args.turnId ?? newTurnId();
  const msg: CaptionMessage = {
    v: 1,
    kind: "caption",
    id,
    ts,
    playAtMs,
    from: args.from,
    sentence: args.sentence,
    confidence: args.confidence,
    usedSigns: args.usedSigns,
    modelId: args.modelId,
    latencyMs: args.latencyMs,
  };

  try {
    await publishDataMessage(args.room, msg);
    LogBus.info("e2e", "caption broadcast", {
      id,
      sentence: args.sentence,
      playAtMs,
      lookaheadMs: playAtMs - ts,
      latencyMs: args.latencyMs,
      modelId: args.modelId,
    });
  } catch (err) {
    LogBus.error("e2e", "caption broadcast failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
