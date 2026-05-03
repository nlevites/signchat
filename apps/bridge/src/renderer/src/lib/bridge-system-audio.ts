import { log } from "@signchat/runtime-browser/logger";

/**
 * `BridgeSystemAudio` captures the audio loopback Bridge transcribes —
 * normally the BlackHole 16ch input device fed by the user's Multi-Output
 * Device.
 *
 * Why this exists:
 * - `createSttStream` in `@signchat/runtime-browser/elevenlabs/stt-streaming`
 *   takes a generic `MediaStream`. This module produces that stream from
 *   a chosen device id, with all of Chromium's mic-side audio processing
 *   disabled (AEC/NS/AGC would chew up the call audio because there's no
 *   real microphone to suppress against — the loopback is already clean).
 * - The track may end (`onended`) if the user re-jiggers Audio MIDI Setup
 *   or unplugs an aggregate device. The caller can listen via `onEnded`
 *   and either stop the STT stream or re-acquire.
 */

export interface BridgeSystemAudioOptions {
  /** BlackHole 16ch input deviceId, from `enumerateDevices()`. */
  inputDeviceId: string;
}

export interface BridgeSystemAudio {
  stream: MediaStream;
  inputDeviceId: string;
  /** True after stop() has run (or the underlying track ended unexpectedly). */
  closed: boolean;
  /** Subscribe to the underlying track ending. Returns an unsubscribe. */
  onEnded(cb: () => void): () => void;
  /** Stop the capture and release tracks. Idempotent. */
  stop(): void;
}

export async function openBridgeSystemAudio(
  options: BridgeSystemAudioOptions,
): Promise<BridgeSystemAudio> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not available in this environment");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: { exact: options.inputDeviceId },
      // BlackHole already provides a clean digital loopback; let Chromium's
      // AEC/NS/AGC anywhere near it and the call audio gets attenuated and
      // smeared. Pass the raw signal straight through to ElevenLabs STT.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    video: false,
  });
  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const t of stream.getTracks()) t.stop();
    throw new Error("BlackHole input device returned no audio track");
  }
  log.info("bridge-system-audio", "loopback opened", {
    inputDeviceId: options.inputDeviceId,
    trackId: track.id,
    label: track.label,
  });

  const endedSubscribers = new Set<() => void>();
  let closed = false;
  const handleEnded = () => {
    if (closed) return;
    closed = true;
    log.info("bridge-system-audio", "loopback track ended");
    for (const cb of endedSubscribers) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  };
  track.addEventListener("ended", handleEnded);

  return {
    stream,
    inputDeviceId: options.inputDeviceId,
    get closed() {
      return closed;
    },
    onEnded(cb: () => void): () => void {
      endedSubscribers.add(cb);
      return () => {
        endedSubscribers.delete(cb);
      };
    },
    stop(): void {
      if (closed) return;
      closed = true;
      try {
        track.removeEventListener("ended", handleEnded);
      } catch {
        // ignore
      }
      for (const t of stream.getTracks()) {
        try {
          t.stop();
        } catch {
          // ignore
        }
      }
      log.debug("bridge-system-audio", "stopped");
    },
  };
}
