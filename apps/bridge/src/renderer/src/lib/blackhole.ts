/**
 * BlackHole virtual-audio-device detection.
 *
 * Bridge depends on two separate BlackHole channel-count variants on macOS:
 *
 *   - **BlackHole 2ch** is an `audiooutput` device. Bridge plays its TTS
 *     into this device via `AudioContext({ sinkId })`. The user picks the
 *     same device's input side as the microphone in Zoom / Discord, which
 *     is how Bridge becomes "the user's voice" in the call.
 *   - **BlackHole 16ch** is the `audioinput` side of a separate device,
 *     used as a loopback the user routes the call's incoming audio into
 *     via a Multi-Output Device. Bridge captures from this device with
 *     `getUserMedia` and feeds the resulting MediaStream into ElevenLabs
 *     Realtime STT for the rolling Hearing-transcript context.
 *
 * Two distinct devices keep Bridge's own TTS out of the loopback capture:
 * the 2ch sink never appears as the 16ch source, so the model can't hear
 * itself talk.
 *
 * Pure browser-side helper. Returns a tagged result so the Setup screen
 * can show targeted install / configuration hints without re-implementing
 * the labelling logic.
 */

export interface AudioDeviceSummary {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

export interface BlackholeDevices {
  /** BlackHole 2ch output device — the virtual mic Zoom subscribes to. */
  mic2ch: AudioDeviceSummary | null;
  /** BlackHole 16ch input device — the loopback Bridge transcribes from. */
  loopback16ch: AudioDeviceSummary | null;
  /** Every audiooutput discovered (used as the picker fallback). */
  outputs: AudioDeviceSummary[];
  /** Every audioinput discovered (used as the picker fallback). */
  inputs: AudioDeviceSummary[];
  /** Every videoinput discovered (used by the camera picker). */
  cameras: AudioDeviceSummary[];
}

/**
 * `enumerateDevices()` returns empty labels until the user has granted at
 * least one media permission for the page, so we proactively pop a
 * one-shot `getUserMedia({audio:true})` to unlock labels. The track is
 * stopped immediately afterwards. Failure is non-fatal — labels remain
 * empty but device ids are still usable.
 */
async function unlockDeviceLabels(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
  } catch {
    // permission denied / no device — labels stay empty
  }
}

function summarise(d: MediaDeviceInfo): AudioDeviceSummary {
  return { deviceId: d.deviceId, label: d.label, kind: d.kind };
}

const BLACKHOLE_2CH_RE = /BlackHole\s*2ch/i;
const BLACKHOLE_16CH_RE = /BlackHole\s*16ch/i;

export async function findBlackholeDevices(): Promise<BlackholeDevices> {
  await unlockDeviceLabels();
  if (typeof navigator === "undefined" || !navigator.mediaDevices) {
    return {
      mic2ch: null,
      loopback16ch: null,
      outputs: [],
      inputs: [],
      cameras: [],
    };
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  const outputs: AudioDeviceSummary[] = [];
  const inputs: AudioDeviceSummary[] = [];
  const cameras: AudioDeviceSummary[] = [];
  let mic2ch: AudioDeviceSummary | null = null;
  let loopback16ch: AudioDeviceSummary | null = null;
  for (const d of devices) {
    if (d.kind === "audiooutput") {
      const summary = summarise(d);
      outputs.push(summary);
      if (!mic2ch && BLACKHOLE_2CH_RE.test(d.label)) mic2ch = summary;
    } else if (d.kind === "audioinput") {
      const summary = summarise(d);
      inputs.push(summary);
      if (!loopback16ch && BLACKHOLE_16CH_RE.test(d.label)) {
        loopback16ch = summary;
      }
    } else if (d.kind === "videoinput") {
      cameras.push(summarise(d));
    }
  }
  return { mic2ch, loopback16ch, outputs, inputs, cameras };
}

/**
 * Friendly install + Multi-Output Device walkthrough strings the Setup
 * screen renders verbatim. Kept here so the copy lives next to the device
 * detection code that triggers it.
 */
export const BLACKHOLE_INSTALL_STEPS = [
  {
    id: "install",
    title: "Install both BlackHole devices",
    body: "Bridge needs the 2-channel and 16-channel variants. Run this once in Terminal:",
    code: "brew install blackhole-2ch blackhole-16ch",
  },
  {
    id: "multi-output",
    title: "Create a Multi-Output Device for the loopback",
    body: "Open Audio MIDI Setup → click + → Create Multi-Output Device. Check both your normal Speakers / Headphones and BlackHole 16ch. Name it 'Bridge Loopback'.",
  },
  {
    id: "zoom-output",
    title: "Route the call audio through the loopback",
    body: "In Zoom (or Discord, FaceTime, etc.) → Audio settings → Speaker → choose 'Bridge Loopback'. You'll still hear the call through your headphones, and Bridge will receive a copy via BlackHole 16ch.",
  },
  {
    id: "zoom-mic",
    title: "Use BlackHole 2ch as the microphone",
    body: "In the same audio settings → Microphone → choose 'BlackHole 2ch'. Bridge's synthesised voice will play into the call from there.",
  },
] as const;

export const BLACKHOLE_HOMEPAGE = "https://existential.audio/blackhole/";
