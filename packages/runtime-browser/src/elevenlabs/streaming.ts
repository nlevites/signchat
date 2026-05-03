import { log } from "../logger";
import { mark, newTurnId } from "../diagnostics/mark";
import { pcm16LeBase64ToAudioBuffer } from "../audio/decode-pcm";
import type { VoiceMixer } from "../audio/voice-mixer";
import { sanitizeForTts } from "./sanitize";
import {
  connectElevenLabsWss,
  type ElevenLabsWss,
} from "./wss-client";

/**
 * speak() — orchestrate one turn through the ElevenLabs streaming TTS WSS
 * and into the §8.1 voice mixer.
 *
 * Per ARCHITECTURE.md §11.2 the protocol is:
 *   send: { text, flush?: true }
 *   recv: interleaved { audio, alignment?, isFinal? } frames
 *   end : a frame with isFinal: true
 *
 * Phase 4 sends a single text + flush per turn (no streaming text). Phase 6
 * will switch to incremental sends as soon as the LLM TTFT begins.
 *
 * Caller owns the WSS lifetime — a fresh wss can be passed per-turn (open
 * per Speak in v1) or reused across turns. We only do the per-turn marks.
 */

export interface SpeakArgs {
  wss: ElevenLabsWss;
  mixer: VoiceMixer;
  text: string;
  /** When true, ramp mic to 0.3 around the turn. Mode 1 (local) leaves false. */
  duckMic: boolean;
  /** Hard cap on how long we wait for `isFinal: true` after sending. */
  timeoutMs?: number;
  /**
   * Phase 6 hook: fired synchronously when the first audio chunk is
   * scheduled, before the SpeakResult promise resolves. Use this to
   * broadcast a §11.4 caption with `playAtMs` aligned to the first
   * audible sample (the resolved SpeakResult is too late — it fires only
   * after the last sample's `onended`).
   *
   * The argument is the audioCtx-relative absolute time (seconds) of the
   * first audible sample, identical to `SpeakResult.firstAudibleAt`.
   */
  onFirstAudible?: (firstAudibleAt: number) => void;
}

export interface SpeakResult {
  /** Sanitized text actually sent to ElevenLabs. */
  sentText: string;
  /** audioCtx-aligned absolute time of first audible sample (the §11.4 playAtMs). */
  firstAudibleAt: number;
  /** Wall-clock ms from `send` to first `audio` frame received. */
  firstByteMs: number;
  /** Wall-clock ms from `send` to last sample's onended. */
  turnEndMs: number;
  bytesReceived: number;
  chunkCount: number;
  alignmentChars: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export async function speak(args: SpeakArgs): Promise<SpeakResult> {
  const sentText = sanitizeForTts(args.text);
  if (!sentText) {
    throw new Error("speak: text is empty after sanitization");
  }
  await args.mixer.resume();
  args.mixer.resetSchedule();

  const turnId = newTurnId();
  const startedAtPerf = performance.now();
  let firstByteAt: number | null = null;
  let firstAudibleAt: number | null = null;
  let bytesReceived = 0;
  let chunkCount = 0;
  let alignmentChars = 0;
  /** AudioBufferSourceNode endsAt of the most recently scheduled chunk. */
  let lastEndsAt = 0;

  mark("tts.firstByte", turnId, "start");
  mark("tts.firstAudible", turnId, "start");
  mark("tts.turnEnd", turnId, "start");

  return await new Promise<SpeakResult>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const timeout = setTimeout(() => {
      cleanup();
      settle(() =>
        reject(
          new Error(
            `speak: timed out after ${args.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms ` +
              `waiting for isFinal (chunks=${chunkCount}, bytes=${bytesReceived})`,
          ),
        ),
      );
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    let unduckScheduled = false;
    const cleanup = () => {
      clearTimeout(timeout);
      unsubscribe();
    };

    const unsubscribe = args.wss.onMessage((frame) => {
      switch (frame.kind) {
        case "audio": {
          if (firstByteAt === null) {
            firstByteAt = performance.now();
            mark("tts.firstByte", turnId, "end");
          }
          let buffer;
          try {
            buffer = pcm16LeBase64ToAudioBuffer(
              args.mixer.audioCtx,
              frame.audioBase64,
            );
          } catch (err) {
            log.warn("elevenlabs", "failed to decode audio frame", {
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
          bytesReceived += Math.floor(frame.audioBase64.length * 0.75);
          chunkCount += 1;
          if (frame.alignment) {
            alignmentChars += frame.alignment.chars.length;
          }
          const { startedAt, endsAt } = args.mixer.scheduleTtsChunk(buffer);
          lastEndsAt = endsAt;
          if (firstAudibleAt === null) {
            firstAudibleAt = startedAt;
            mark("tts.firstAudible", turnId, "end");
            if (args.duckMic) {
              args.mixer.duckMic(startedAt);
              unduckScheduled = false;
            }
            if (args.onFirstAudible) {
              try {
                args.onFirstAudible(startedAt);
              } catch (err) {
                log.warn("elevenlabs", "onFirstAudible threw (ignored)", {
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          }
          // Schedule the unduck against the current "last chunk" end. If
          // more chunks arrive before isFinal, the next iteration will
          // re-schedule unduck farther out, which is correct.
          if (args.duckMic) {
            args.mixer.unduckMic(endsAt);
            unduckScheduled = true;
          }
          if (frame.isFinal) {
            finishWhenAudioDone();
          }
          break;
        }
        case "alignment": {
          alignmentChars += frame.alignment.chars.length;
          if (frame.isFinal) finishWhenAudioDone();
          break;
        }
        case "final":
          finishWhenAudioDone();
          break;
        case "error":
          cleanup();
          settle(() =>
            reject(new Error(`ElevenLabs WSS error: ${frame.message}`)),
          );
          break;
      }
    });

    const finishWhenAudioDone = () => {
      if (settled) return;
      // Wait until the last scheduled sample ends so `turnEnd` reflects
      // when the audio is actually audible to the listener, not just
      // when the server stopped streaming.
      const wait = Math.max(
        0,
        (lastEndsAt - args.mixer.audioCtx.currentTime) * 1000,
      );
      setTimeout(() => {
        if (settled) return;
        if (args.duckMic && unduckScheduled) {
          // Ensure we always end with mic at full gain even if no audio
          // chunks arrived (e.g., empty TTS response) to avoid a
          // permanently ducked mic.
          args.mixer.unduckMic(args.mixer.audioCtx.currentTime);
        }
        const turnEndMs = performance.now() - startedAtPerf;
        mark("tts.turnEnd", turnId, "end");
        cleanup();
        settle(() =>
          resolve({
            sentText,
            firstAudibleAt: firstAudibleAt ?? args.mixer.audioCtx.currentTime,
            firstByteMs:
              firstByteAt !== null ? firstByteAt - startedAtPerf : turnEndMs,
            turnEndMs,
            bytesReceived,
            chunkCount,
            alignmentChars,
          }),
        );
      }, wait);
    };

    try {
      // ElevenLabs stream-input protocol (verified by scripts/test-elevenlabs.mjs):
      //   1) init frame with single-space text + voice_settings + generation_config
      //   2) content frame with the actual sentence + try_trigger_generation
      //   3) EOS frame with empty text to flush remaining audio and trigger isFinal
      // Phase 4 sends all three per Speak (open-per-turn). Phase 6 will keep
      // the WSS warm and reuse the init across turns.
      args.wss.send({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        generation_config: {
          chunk_length_schedule: [120, 160, 250, 290],
        },
      });
      args.wss.send({ text: sentText, try_trigger_generation: true });
      args.wss.send({ text: "" });
    } catch (err) {
      cleanup();
      settle(() =>
        reject(
          err instanceof Error ? err : new Error(`speak: send failed: ${err}`),
        ),
      );
      return;
    }
  });
}

export async function openTurnWss(signedUrl: string): Promise<ElevenLabsWss> {
  // Re-export so callers don't reach into the wss-client module path; keeps
  // the streaming module the single entry-point for "talk to ElevenLabs".
  return connectElevenLabsWss(signedUrl);
}
