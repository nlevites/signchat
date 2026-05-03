/**
 * Decode an ElevenLabs `pcm_24000` audio frame into an AudioBuffer.
 *
 * ElevenLabs streams the audio as base64-encoded raw PCM, signed 16-bit
 * little-endian, mono, 24 kHz sample rate. AudioBuffer expects Float32 in
 * [-1, 1], so we scale by `1 / 32768`. We allocate the buffer at exactly
 * 24 kHz so AudioContext (also at 24 kHz per §8.1) plays it without any
 * resampling on the hot path.
 *
 * Pure helper. No logger / mark dependency so it's also usable from
 * smoke tests.
 */

export const PCM_24000_SAMPLE_RATE = 24_000;

export function pcm16LeBase64ToAudioBuffer(
  audioCtx: AudioContext,
  base64: string,
): AudioBuffer {
  const bytes = base64ToBytes(base64);
  return pcm16LeBytesToAudioBuffer(audioCtx, bytes);
}

export function pcm16LeBytesToAudioBuffer(
  audioCtx: AudioContext,
  bytes: Uint8Array,
): AudioBuffer {
  const sampleCount = Math.floor(bytes.byteLength / 2);
  const buffer = audioCtx.createBuffer(1, sampleCount, PCM_24000_SAMPLE_RATE);
  const out = buffer.getChannelData(0);
  // Build a properly-aligned Int16Array view. Slicing the Uint8Array's
  // underlying ArrayBuffer respects the byteOffset so a sliced buffer
  // doesn't break alignment.
  const i16 = new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    sampleCount,
  );
  for (let i = 0; i < sampleCount; i++) {
    out[i] = (i16[i] as number) / 32768;
  }
  return buffer;
}

interface NodeBuffer {
  buffer: ArrayBufferLike;
  byteOffset: number;
  byteLength: number;
}

interface BufferConstructorLike {
  from(input: string, encoding: string): NodeBuffer;
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof atob !== "undefined") {
    const bin = atob(base64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      out[i] = bin.charCodeAt(i) & 0xff;
    }
    return out;
  }
  // Node fallback for the smoke harness — not used in the browser bundle.
  // Reach Buffer via globalThis so this file doesn't require @types/node
  // to typecheck in renderer-only consumers.
  const nodeBuffer = (globalThis as { Buffer?: BufferConstructorLike }).Buffer;
  if (nodeBuffer) {
    const buf = nodeBuffer.from(base64, "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  throw new Error("no base64 decoder available");
}
