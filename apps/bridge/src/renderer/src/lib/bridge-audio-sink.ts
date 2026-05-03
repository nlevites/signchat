import { log } from "@signchat/runtime-browser/logger";
import type {
  ScheduleResult,
  VoiceMixer,
} from "@signchat/runtime-browser/audio/voice-mixer";

/**
 * `BridgeAudioSink` plays ElevenLabs PCM into a chosen output device
 * (BlackHole 2ch in production) by way of an `AudioContext` constructed
 * with that device's `sinkId`.
 *
 * It satisfies the `VoiceMixer` interface that `speak()` from
 * `@signchat/runtime-browser/elevenlabs/streaming` expects, so we can reuse
 * the entire ElevenLabs streaming + scheduling logic without forking it.
 * Mic-mixing, ducking, and monitor branches are intentional no-ops because
 * Bridge doesn't have a real microphone to mix with — its only output is
 * the synthesised voice.
 *
 * AudioContext.sinkId is set at construction time. Chromium does not
 * support changing it after construction reliably, so to switch BlackHole
 * devices the caller disposes this sink and creates a new one.
 */

interface AudioContextSinkOptions extends AudioContextOptions {
  /**
   * Chromium 116+ accepts `sinkId` here, either as a deviceId string or
   * the structured `{ type: "deviceId", deviceId }` form. Older / fallback
   * versions ignore the field entirely; in those cases the AudioContext
   * uses the system default output (the renderer detects this and surfaces
   * a guidance toast in the Active screen).
   */
  sinkId?:
    | string
    | { type: "none" }
    | { type: "deviceId"; deviceId: string };
}

export interface BridgeAudioSinkOptions {
  /** BlackHole 2ch output deviceId from `enumerateDevices()`. */
  outputDeviceId: string;
  /**
   * Sample rate. Defaults to 24 kHz so ElevenLabs `pcm_24000` chunks need
   * zero resampling.
   */
  sampleRate?: number;
}

export function createBridgeAudioSink(
  options: BridgeAudioSinkOptions,
): VoiceMixer {
  const sampleRate = options.sampleRate ?? 24_000;
  const ctxOptions: AudioContextSinkOptions = {
    sampleRate,
    sinkId: options.outputDeviceId,
  };
  const audioCtx = new AudioContext(ctxOptions as AudioContextOptions);

  const ttsGain = audioCtx.createGain();
  ttsGain.gain.value = 1;
  ttsGain.connect(audioCtx.destination);

  // Satisfy the VoiceMixer interface: speak() reads `outputTrack` from
  // typed mixers in case it ever wants to inspect it. Bridge never uses
  // it, so we wire a tiny MediaStreamDestination off the same context
  // (zero-cost — a passive sink the GC reaps when dispose runs).
  const outputDest = audioCtx.createMediaStreamDestination();
  const outputTrack = outputDest.stream.getAudioTracks()[0];
  if (!outputTrack) {
    audioCtx.close();
    throw new Error(
      "BridgeAudioSink: MediaStreamDestination produced no audio track",
    );
  }

  let nextStartAt = audioCtx.currentTime;

  log.info("bridge-audio-sink", "created", {
    sampleRate,
    outputDeviceId: options.outputDeviceId,
    audioCtxState: audioCtx.state,
  });

  const noopMic = (label: string) => () => {
    // Bridge has no real mic to attach / duck — no-op so the speak()
    // ducking branch (which we never enable on Bridge) is also safe.
    log.debug("bridge-audio-sink", `${label}: no-op (Bridge has no mic)`);
  };

  return {
    audioCtx,
    outputTrack,
    attachMic: noopMic("attachMic"),
    detachMic: noopMic("detachMic"),
    setMonitorEnabled(on: boolean): void {
      log.debug("bridge-audio-sink", "setMonitorEnabled: no-op", { on });
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
    duckMic: noopMic("duckMic"),
    unduckMic: noopMic("unduckMic"),
    async resume(): Promise<void> {
      if (audioCtx.state !== "running") {
        await audioCtx.resume();
      }
    },
    dispose(): void {
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
      log.debug("bridge-audio-sink", "disposed");
    },
  };
}
