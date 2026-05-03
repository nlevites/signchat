import { log } from "../logger";

/**
 * `signchat-voice` Web Audio mixer per ARCHITECTURE.md §8.1.
 *
 *   getUserMedia mic ─► micGain (1.0 → 0.3 ducked) ─┐
 *                                                   ├─► MediaStreamDestination ─► outputTrack
 *   ElevenLabs PCM   ─► AudioBufferSourceNode → ttsGain (1.0) ─┘
 *
 * Properties guaranteed:
 * - One AudioContext at 24 kHz so ElevenLabs `pcm_24000` chunks need zero
 *   resampling.
 * - `outputTrack` is the only thing the LiveKit pane should publish — the
 *   raw mic track is never published directly.
 * - TTS chunks scheduled by `scheduleTtsChunk` play back-to-back: the
 *   mixer maintains `nextStartAt` so jitter in chunk-arrival latency
 *   doesn't introduce silence between consecutive chunks.
 * - Mic ducking uses `linearRampToValueAtTime` over 50 ms, and the values
 *   are documented (1.0 → 0.3 → 1.0).
 * - Monitor toggle pipes the dest stream to AudioContext.destination so
 *   the operator can hear what the remote subscriber would hear.
 * - `document.visibilitychange` listener calls `audioCtx.resume()` and
 *   warns when the tab was hidden mid-turn (§8.3).
 */

export interface ScheduleResult {
  /** audioCtx-aligned absolute start time. Used as the §11.4 `playAtMs`. */
  startedAt: number;
  /** audioCtx-aligned absolute end time (start + buffer.duration). */
  endsAt: number;
}

export interface VoiceMixer {
  audioCtx: AudioContext;
  /** Single output track; identity is stable across the mixer's lifetime. */
  outputTrack: MediaStreamTrack;
  /** Acquire and route the mic into the graph. */
  attachMic(stream: MediaStream): void;
  /** Disconnect the mic node. The MediaStream itself is owned by the caller. */
  detachMic(): void;
  /** Pipe the mixed dest stream to AudioContext.destination for local monitoring. */
  setMonitorEnabled(on: boolean): void;
  /** Schedule one TTS chunk; back-to-back with previously scheduled chunks. */
  scheduleTtsChunk(buffer: AudioBuffer): ScheduleResult;
  /**
   * Reset the back-to-back scheduler. Call before the first chunk of a
   * new turn so old `nextStartAt` from a previous turn doesn't add a
   * stale offset.
   */
  resetSchedule(): void;
  /** Ramp mic gain to 0.3 over 50 ms starting at `when`. */
  duckMic(when: number): void;
  /** Ramp mic gain to 1.0 over 50 ms starting at `when`. */
  unduckMic(when: number): void;
  /** Resume the AudioContext (browsers gate this behind a user gesture). */
  resume(): Promise<void>;
  /** Tear everything down. The mixer is single-shot — call createVoiceMixer() again. */
  dispose(): void;
}

const DUCK_GAIN = 0.3;
const FULL_GAIN = 1.0;
const DUCK_RAMP_S = 0.05; // 50 ms per §8.1

export interface VoiceMixerOptions {
  /** Defaults to 24_000 to match `pcm_24000`. */
  sampleRate?: number;
}

export function createVoiceMixer(options: VoiceMixerOptions = {}): VoiceMixer {
  const sampleRate = options.sampleRate ?? 24_000;
  const audioCtx = new AudioContext({ sampleRate });

  const dest = audioCtx.createMediaStreamDestination();
  const micGain = audioCtx.createGain();
  micGain.gain.value = FULL_GAIN;
  micGain.connect(dest);

  const ttsGain = audioCtx.createGain();
  ttsGain.gain.value = FULL_GAIN;
  ttsGain.connect(dest);

  let micSourceNode: MediaStreamAudioSourceNode | null = null;
  let monitorSourceNode: MediaStreamAudioSourceNode | null = null;
  let monitorOn = false;
  let nextStartAt = audioCtx.currentTime;
  const visibilityHandler = () => {
    if (document.visibilityState === "visible") {
      void audioCtx.resume();
      log.info("audio", "audioCtx resumed on visibilitychange");
    } else {
      log.debug("audio", "audioCtx suspended (tab hidden)");
    }
  };
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", visibilityHandler);
  }

  const outputTrack = dest.stream.getAudioTracks()[0];
  if (!outputTrack) {
    audioCtx.close();
    throw new Error(
      "MediaStreamDestination produced no audio track — voice mixer cannot start",
    );
  }

  log.debug("audio", "voice mixer created", {
    sampleRate,
    outputTrackId: outputTrack.id,
  });

  return {
    audioCtx,
    outputTrack,
    attachMic(stream: MediaStream): void {
      if (micSourceNode) {
        try {
          micSourceNode.disconnect();
        } catch {
          // ignore
        }
        micSourceNode = null;
      }
      const tracks = stream.getAudioTracks();
      if (tracks.length === 0) {
        throw new Error("attachMic: stream has no audio tracks");
      }
      micSourceNode = audioCtx.createMediaStreamSource(stream);
      micSourceNode.connect(micGain);
      log.debug("audio", "mic attached", {
        trackId: tracks[0]?.id,
      });
    },
    detachMic(): void {
      if (micSourceNode) {
        try {
          micSourceNode.disconnect();
        } catch {
          // ignore
        }
        micSourceNode = null;
        log.debug("audio", "mic detached");
      }
    },
    setMonitorEnabled(on: boolean): void {
      if (on === monitorOn) return;
      monitorOn = on;
      if (on) {
        // Pipe dest stream back through a separate MediaStreamSource so
        // the operator can hear it without short-circuiting the publish
        // path. Connecting the dest node itself to `audioCtx.destination`
        // would feed back through the publish path on some implementations.
        monitorSourceNode = audioCtx.createMediaStreamSource(dest.stream);
        monitorSourceNode.connect(audioCtx.destination);
      } else if (monitorSourceNode) {
        try {
          monitorSourceNode.disconnect();
        } catch {
          // ignore
        }
        monitorSourceNode = null;
      }
      log.debug("audio", "monitor toggled", { on });
    },
    scheduleTtsChunk(buffer: AudioBuffer): ScheduleResult {
      const now = audioCtx.currentTime;
      const startAt = Math.max(now, nextStartAt);
      const source = audioCtx.createBufferSource();
      source.buffer = buffer;
      source.connect(ttsGain);
      source.start(startAt);
      const endsAt = startAt + buffer.duration;
      nextStartAt = endsAt;
      return { startedAt: startAt, endsAt };
    },
    resetSchedule(): void {
      nextStartAt = audioCtx.currentTime;
    },
    duckMic(when: number): void {
      const target = Math.max(when, audioCtx.currentTime);
      micGain.gain.cancelScheduledValues(target);
      micGain.gain.setValueAtTime(micGain.gain.value, target);
      micGain.gain.linearRampToValueAtTime(DUCK_GAIN, target + DUCK_RAMP_S);
    },
    unduckMic(when: number): void {
      const target = Math.max(when, audioCtx.currentTime);
      micGain.gain.cancelScheduledValues(target);
      micGain.gain.setValueAtTime(micGain.gain.value, target);
      micGain.gain.linearRampToValueAtTime(FULL_GAIN, target + DUCK_RAMP_S);
    },
    async resume(): Promise<void> {
      if (audioCtx.state !== "running") {
        await audioCtx.resume();
      }
    },
    dispose(): void {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", visibilityHandler);
      }
      if (micSourceNode) {
        try {
          micSourceNode.disconnect();
        } catch {
          // ignore
        }
        micSourceNode = null;
      }
      if (monitorSourceNode) {
        try {
          monitorSourceNode.disconnect();
        } catch {
          // ignore
        }
        monitorSourceNode = null;
      }
      try {
        outputTrack.stop();
      } catch {
        // ignore
      }
      try {
        void audioCtx.close();
      } catch {
        // ignore
      }
      log.debug("audio", "voice mixer disposed");
    },
  };
}
