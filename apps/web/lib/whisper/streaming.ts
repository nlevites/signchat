/**
 * Deaf-side Whisper streaming loop (ARCHITECTURE.md §5.8 + §6.1).
 *
 * Subscribes to the Hearing user's `RemoteAudioTrack`, runs Silero VAD-gated
 * `whisper-base.en` locally, and broadcasts streaming partials + a final per
 * utterance back to the Hearing user via LiveKit DataChannel. The Hearing
 * tile renders word-by-word partials replacing in place; finals lock into
 * the global Transcript strip.
 *
 * Pipeline:
 *   RemoteAudioTrack.mediaStreamTrack
 *     → MediaStream → AudioContext(16 kHz)
 *     → MediaStreamSource → AudioWorkletNode (PCM frame chunker)
 *     → Silero VAD (32 ms / 512-sample frames)
 *     → utterance state machine
 *     → @huggingface/transformers Whisper pipeline (CDN-loaded)
 *     → publishRoomDataMessage(transcript_partial / transcript_final)
 *
 * Module-scope caches: the transformers.js module, the per-modelId Whisper
 * pipeline, and the Silero VAD InferenceSession are all loaded once and
 * reused across every WhisperStream instance for the lifetime of the page.
 * The Lobby has already prewarmed both during device preview, so by `start()`
 * the binaries are in IndexedDB / HTTP cache and the pipeline is hot.
 */

import type { RemoteAudioTrack } from "livekit-client";
import type { ParticipantInfo, RoomDataMessage } from "@signchat/contracts";

import { mark } from "@/lib/diagnostics/latency-markers";
import { LogBus } from "@/lib/diagnostics/log-bus";
import {
  loadOrt,
  type OrtInferenceSession,
  type OrtTensor,
  type OrtTensorType,
} from "@/lib/sign-pipeline/onnx-session";
import { useTranscriptStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

// ===== public surface ======================================================

export type WhisperStreamModelId =
  | "Xenova/whisper-tiny.en"
  | "Xenova/whisper-base.en"
  | "Xenova/whisper-small.en";

export interface WhisperStreamConfig {
  modelId: WhisperStreamModelId;
  remoteAudioTrack: RemoteAudioTrack;
  /** ParticipantInfo for the Hearing speaker (used in published RoomDataMessages). */
  speaker: ParticipantInfo;
  /** Function to publish a RoomDataMessage on the LiveKit data channel. */
  publish: (msg: RoomDataMessage) => Promise<void>;
}

export interface WhisperStream {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ===== tunables ============================================================

// 32 ms @ 16 kHz. Silero VAD is fixed at 512 samples for 16 kHz; emitting
// 512-sample frames from the worklet aligns directly with VAD input and is
// >= the 480-sample (30 ms) floor in §5.8.
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 512;

// Silero VAD threshold. > 0.5 = speech.
const VAD_SPEECH_THRESHOLD = 0.5;

// Speech-end after ~250 ms continuous silence. 8 frames * 32 ms = 256 ms.
const SILENCE_FRAMES_FOR_END = 8;

// Schedule a partial Whisper inference whenever the utterance has grown by
// at least this many samples since the last partial was scheduled (1 s @ 16 kHz).
const PARTIAL_INTERVAL_SAMPLES = SAMPLE_RATE;

// Coalescing gates per task spec: publish only when (>= 250 ms since the last
// publish) OR (text changed since the last publish).
const PUBLISH_COALESCE_MS = 250;

// Captions-degraded heuristic per ARCHITECTURE §5.8: when the per-utterance
// p50 partial latency exceeds 1.5 s for three consecutive utterances, flip
// the degraded chip on. Reset to clean as soon as one utterance comes in
// under the threshold.
const DEGRADED_LATENCY_MS = 1500;
const DEGRADED_CONSECUTIVE_LIMIT = 3;

// Cap the queue of unprocessed frames so a stuck VAD inference doesn't grow
// memory unboundedly. 64 frames * 32 ms = ~2 s of audio.
const MAX_FRAME_QUEUE = 64;

// ===== module-scope shared resources =======================================

const TRANSFORMERS_CDN = "https://esm.sh/@huggingface/transformers@3.0.2";
const SILERO_VAD_URL =
  "https://huggingface.co/onnx-community/silero-vad/resolve/main/onnx/model.onnx";

interface AsrPipelineResult {
  text: string;
}

type AsrPipeline = (
  audio: Float32Array,
  options?: Record<string, unknown>,
) => Promise<AsrPipelineResult | AsrPipelineResult[]>;

interface PipelineFactoryOptions {
  device?: "webgpu" | "wasm";
  dtype?: "fp32" | "fp16" | "q8" | "q4";
}

interface TransformersOrtEnv {
  logLevel?: "verbose" | "info" | "warning" | "error" | "fatal";
}

interface TransformersModule {
  pipeline: (
    task: "automatic-speech-recognition",
    model: string,
    opts?: PipelineFactoryOptions,
  ) => Promise<AsrPipeline>;
  env: {
    allowLocalModels: boolean;
    backends?: { onnx?: TransformersOrtEnv };
  };
}

let transformersModulePromise: Promise<TransformersModule> | null = null;

function loadTransformers(): Promise<TransformersModule> {
  if (!transformersModulePromise) {
    const dynamicImport = new Function("u", "return import(u);") as (
      u: string,
    ) => Promise<TransformersModule>;
    transformersModulePromise = dynamicImport(TRANSFORMERS_CDN).then((m) => {
      m.env.allowLocalModels = false;
      const ortEnv = m.env.backends?.onnx;
      if (ortEnv) ortEnv.logLevel = "error";
      return m;
    });
  }
  return transformersModulePromise;
}

const pipelineByModelId = new Map<string, Promise<AsrPipeline>>();

function loadAsrPipeline(modelId: WhisperStreamModelId): Promise<AsrPipeline> {
  let p = pipelineByModelId.get(modelId);
  if (p) return p;
  p = (async () => {
    const mod = await loadTransformers();
    const hasWebGPU = typeof navigator !== "undefined" && "gpu" in navigator;
    const device: "webgpu" | "wasm" = hasWebGPU ? "webgpu" : "wasm";
    LogBus.info("whisper", "loading ASR pipeline", { modelId, device });
    return mod.pipeline("automatic-speech-recognition", modelId, {
      device,
      dtype: device === "webgpu" ? "fp32" : "q8",
    });
  })();
  pipelineByModelId.set(modelId, p);
  return p;
}

let vadSessionPromise: Promise<OrtInferenceSession> | null = null;

function loadVadSession(): Promise<OrtInferenceSession> {
  if (vadSessionPromise) return vadSessionPromise;
  vadSessionPromise = (async () => {
    const ort = await loadOrt();
    const res = await fetch(SILERO_VAD_URL, { cache: "force-cache" });
    if (!res.ok) throw new Error(`silero vad fetch failed: ${res.status}`);
    const buffer = await res.arrayBuffer();
    LogBus.info("whisper", "creating Silero VAD session", {
      bytes: buffer.byteLength,
    });
    return ort.InferenceSession.create(buffer, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: "all",
    });
  })();
  return vadSessionPromise;
}

// Silero VAD takes int64 sample-rate input which onnx-session.ts's narrow
// constructor type doesn't expose. Cast through a structural alias rather
// than widening the shared type.
interface VadTensorConstructor {
  new (
    type: OrtTensorType,
    data: Float32Array | BigInt64Array,
    dims: ReadonlyArray<number>,
  ): OrtTensor;
}

// ===== AudioWorklet processor ==============================================

const PCM_FRAME_PROCESSOR_NAME = "signchat-pcm-frame";
const PCM_FRAME_PROCESSOR_SRC = `
class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(0);
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    const merged = new Float32Array(this._buf.length + channel.length);
    merged.set(this._buf, 0);
    merged.set(channel, this._buf.length);
    this._buf = merged;
    const FRAME_SIZE = ${FRAME_SAMPLES};
    while (this._buf.length >= FRAME_SIZE) {
      const frame = this._buf.slice(0, FRAME_SIZE);
      this._buf = this._buf.slice(FRAME_SIZE);
      this.port.postMessage(frame, [frame.buffer]);
    }
    return true;
  }
}
registerProcessor('${PCM_FRAME_PROCESSOR_NAME}', PcmFrameProcessor);
`;

let workletModuleUrl: string | null = null;
function getWorkletModuleUrl(): string {
  if (workletModuleUrl) return workletModuleUrl;
  const blob = new Blob([PCM_FRAME_PROCESSOR_SRC], {
    type: "application/javascript",
  });
  workletModuleUrl = URL.createObjectURL(blob);
  return workletModuleUrl;
}

// ===== utterance state machine =============================================

type UtteranceState = "idle" | "voiced";

interface UtteranceContext {
  id: string;
  /** Frames captured during this utterance (concat lazily at inference time). */
  frames: Float32Array[];
  /** Total samples captured across all frames in `frames`. */
  totalSamples: number;
  /** Sample count at which the next partial inference should fire. */
  nextPartialAtSamples: number;
  /** Most-recent published partial text (used by the coalescing gate). */
  lastPublishedText: string;
  /** Wall-clock ms when we last published a partial for this utterance. */
  lastPublishedAtMs: number;
  /** Has the very first partial for this utterance been published yet? */
  firstPartialPublished: boolean;
  /** Per-partial latency samples used to compute the utterance-level p50. */
  partialDurationsMs: number[];
}

// ===== implementation ======================================================

interface InternalStreamState {
  cfg: WhisperStreamConfig;
  audioCtx: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  vadSession: OrtInferenceSession | null;
  vadState: Float32Array;
  asrPipeline: AsrPipeline | null;
  state: UtteranceState;
  utterance: UtteranceContext | null;
  silenceFrames: number;
  /** Pending frame queue + serialization flag, fed by the worklet message port. */
  frameQueue: Float32Array[];
  pumpRunning: boolean;
  /** True after start() succeeded, false again after stop() (or a failure). */
  active: boolean;
  /**
   * Number of recent utterances whose p50 partial latency exceeded the
   * degraded threshold. Reset to 0 when an utterance comes in clean.
   */
  consecutiveDegradedUtterances: number;
}

export function createWhisperStream(cfg: WhisperStreamConfig): WhisperStream {
  const internal: InternalStreamState = {
    cfg,
    audioCtx: null,
    workletNode: null,
    sourceNode: null,
    vadSession: null,
    vadState: new Float32Array(2 * 1 * 128),
    asrPipeline: null,
    state: "idle",
    utterance: null,
    silenceFrames: 0,
    frameQueue: [],
    pumpRunning: false,
    active: false,
    consecutiveDegradedUtterances: 0,
  };

  return {
    start: () => start(internal),
    stop: () => stop(internal),
  };
}

async function start(s: InternalStreamState): Promise<void> {
  if (s.active) return;
  try {
    const [vadSession, asrPipeline] = await Promise.all([
      loadVadSession(),
      loadAsrPipeline(s.cfg.modelId),
    ]);
    s.vadSession = vadSession;
    s.asrPipeline = asrPipeline;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    LogBus.error("whisper", "VAD or ASR pipeline failed to load", { message });
    toast.error("Captions unavailable");
    return;
  }

  try {
    const mst = s.cfg.remoteAudioTrack.mediaStreamTrack;
    if (!mst) {
      throw new Error("RemoteAudioTrack has no mediaStreamTrack");
    }
    const stream = new MediaStream([mst]);

    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    s.audioCtx = audioCtx;

    await audioCtx.audioWorklet.addModule(getWorkletModuleUrl());
    const workletNode = new AudioWorkletNode(
      audioCtx,
      PCM_FRAME_PROCESSOR_NAME,
      {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      },
    );
    workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      onFrameFromWorklet(s, e.data);
    };
    s.workletNode = workletNode;

    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(workletNode);
    s.sourceNode = source;

    if (audioCtx.state !== "running") {
      try {
        await audioCtx.resume();
      } catch {
        // resume can reject on some browsers without a user gesture; the
        // worklet still drives `process` once the track delivers samples.
      }
    }

    s.active = true;
    if (audioCtx.sampleRate !== SAMPLE_RATE) {
      LogBus.warn("whisper", "AudioContext sample rate mismatch", {
        requested: SAMPLE_RATE,
        actual: audioCtx.sampleRate,
      });
    }
    LogBus.info("whisper", "stream started", {
      modelId: s.cfg.modelId,
      sampleRate: audioCtx.sampleRate,
      speaker: s.cfg.speaker.identity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    LogBus.error("whisper", "failed to attach audio graph", { message });
    toast.error("Captions unavailable");
    await stop(s);
  }
}

async function stop(s: InternalStreamState): Promise<void> {
  s.active = false;
  s.frameQueue.length = 0;
  if (s.workletNode) {
    try {
      s.workletNode.port.onmessage = null;
      s.workletNode.disconnect();
    } catch {
      // ignore
    }
    s.workletNode = null;
  }
  if (s.sourceNode) {
    try {
      s.sourceNode.disconnect();
    } catch {
      // ignore
    }
    s.sourceNode = null;
  }
  if (s.audioCtx) {
    try {
      await s.audioCtx.close();
    } catch {
      // ignore
    }
    s.audioCtx = null;
  }
  s.utterance = null;
  s.state = "idle";
  s.silenceFrames = 0;
  s.vadState = new Float32Array(2 * 1 * 128);
  LogBus.debug("whisper", "stream stopped");
}

function onFrameFromWorklet(s: InternalStreamState, frame: Float32Array): void {
  if (!s.active) return;
  if (s.frameQueue.length >= MAX_FRAME_QUEUE) {
    // Drop the oldest frame so we don't let backpressure rip through main
    // thread memory; one dropped frame is preferable to a stuck VAD.
    s.frameQueue.shift();
    LogBus.warn("whisper", "frame queue full; dropping oldest frame");
  }
  s.frameQueue.push(frame);
  void runFramePump(s);
}

async function runFramePump(s: InternalStreamState): Promise<void> {
  if (s.pumpRunning) return;
  s.pumpRunning = true;
  try {
    while (s.active && s.frameQueue.length > 0) {
      const frame = s.frameQueue.shift();
      if (!frame) break;
      try {
        await processFrame(s, frame);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        LogBus.error("whisper", "frame processing error", { message });
      }
    }
  } finally {
    s.pumpRunning = false;
  }
}

async function processFrame(
  s: InternalStreamState,
  frame: Float32Array,
): Promise<void> {
  const session = s.vadSession;
  if (!session) return;
  const prob = await runVad(session, frame, s.vadState);

  if (s.state === "idle") {
    if (prob >= VAD_SPEECH_THRESHOLD) {
      beginUtterance(s, frame);
    }
    return;
  }

  // voiced
  const u = s.utterance;
  if (!u) {
    s.state = "idle";
    return;
  }

  u.frames.push(frame);
  u.totalSamples += frame.length;

  if (prob < VAD_SPEECH_THRESHOLD) {
    s.silenceFrames += 1;
    if (s.silenceFrames >= SILENCE_FRAMES_FOR_END) {
      void endUtterance(s);
      return;
    }
  } else {
    s.silenceFrames = 0;
  }

  if (u.totalSamples >= u.nextPartialAtSamples) {
    u.nextPartialAtSamples = u.totalSamples + PARTIAL_INTERVAL_SAMPLES;
    void runPartial(s, u);
  }
}

async function runVad(
  session: OrtInferenceSession,
  frame: Float32Array,
  state: Float32Array,
): Promise<number> {
  const ort = await loadOrt();
  const TensorCtor = ort.Tensor as unknown as VadTensorConstructor;
  const inputTensor = new TensorCtor("float32", frame, [1, frame.length]);
  const stateTensor = new TensorCtor("float32", state, [2, 1, 128]);
  const srTensor = new TensorCtor(
    "int64",
    BigInt64Array.from([BigInt(SAMPLE_RATE)]),
    [1],
  );
  const outputs = await session.run({
    input: inputTensor,
    state: stateTensor,
    sr: srTensor,
  });
  const out = outputs["output"];
  const stateOut = outputs["stateN"];
  if (!out || !(out.data instanceof Float32Array)) {
    throw new Error("Silero VAD output missing or wrong dtype");
  }
  if (stateOut && stateOut.data instanceof Float32Array) {
    state.set(stateOut.data);
  }
  return out.data[0] ?? 0;
}

function beginUtterance(s: InternalStreamState, firstFrame: Float32Array): void {
  const id = newUtteranceId();
  const ctx: UtteranceContext = {
    id,
    frames: [firstFrame],
    totalSamples: firstFrame.length,
    nextPartialAtSamples: PARTIAL_INTERVAL_SAMPLES,
    lastPublishedText: "",
    lastPublishedAtMs: 0,
    firstPartialPublished: false,
    partialDurationsMs: [],
  };
  s.utterance = ctx;
  s.state = "voiced";
  s.silenceFrames = 0;
  mark("whisper.first-partial", id, "start");
  LogBus.debug("whisper", "speech-start", { id });
}

async function runPartial(
  s: InternalStreamState,
  u: UtteranceContext,
): Promise<void> {
  const pipeline = s.asrPipeline;
  if (!pipeline) return;
  // Snapshot the audio so further frames arriving mid-inference don't
  // mutate the buffer we hand to Whisper.
  const audio = concatFrames(u.frames, u.totalSamples);
  const partialId = `${u.id}::p${u.partialDurationsMs.length}`;
  mark("whisper.partial", partialId, "start");
  const startedPerf = performance.now();
  let text: string;
  try {
    const result = await pipeline(audio);
    text = pickText(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    LogBus.warn("whisper", "partial inference failed", { message });
    return;
  }
  mark("whisper.partial", partialId, "end");
  const elapsed = performance.now() - startedPerf;
  u.partialDurationsMs.push(elapsed);

  // Only the active utterance is allowed to publish; if speech-end already
  // fired, the final-publish path owns the close-out.
  if (s.utterance !== u) return;
  publishPartial(s, u, text);
}

function publishPartial(
  s: InternalStreamState,
  u: UtteranceContext,
  rawText: string,
): void {
  const text = rawText.trim();
  if (text.length === 0) return;
  const now = Date.now();
  const sinceLast = now - u.lastPublishedAtMs;
  const textChanged = text !== u.lastPublishedText;
  if (sinceLast < PUBLISH_COALESCE_MS && !textChanged) return;
  u.lastPublishedAtMs = now;
  u.lastPublishedText = text;

  if (!u.firstPartialPublished) {
    mark("whisper.first-partial", u.id, "end");
    u.firstPartialPublished = true;
  }

  const msg: RoomDataMessage = {
    v: 1,
    kind: "transcript_partial",
    id: u.id,
    ts: now,
    from: s.cfg.speaker,
    text,
  };
  // Update the local store first so the Deaf user's UI updates without
  // waiting on the data channel round-trip.
  useTranscriptStore
    .getState()
    .upsertPartial(u.id, { from: s.cfg.speaker, text, ts: now });
  void s.cfg.publish(msg).catch((err) => {
    LogBus.warn("whisper", "transcript_partial publish failed", {
      error: err instanceof Error ? err.message : String(err),
      id: u.id,
    });
  });
}

async function endUtterance(s: InternalStreamState): Promise<void> {
  const u = s.utterance;
  if (!u) {
    s.state = "idle";
    s.silenceFrames = 0;
    return;
  }
  s.utterance = null;
  s.state = "idle";
  s.silenceFrames = 0;
  LogBus.debug("whisper", "speech-end", {
    id: u.id,
    durationMs: u.totalSamples * (1000 / SAMPLE_RATE),
    partials: u.partialDurationsMs.length,
  });
  await runFinal(s, u);
  trackUtteranceLatency(s, u);
}

async function runFinal(
  s: InternalStreamState,
  u: UtteranceContext,
): Promise<void> {
  const pipeline = s.asrPipeline;
  if (!pipeline) return;
  const audio = concatFrames(u.frames, u.totalSamples);
  let text: string;
  try {
    const result = await pipeline(audio);
    text = pickText(result).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    LogBus.warn("whisper", "final inference failed", { message });
    return;
  }
  if (text.length === 0) {
    // No usable transcript — still finalize the partial entry so the UI
    // doesn't keep showing a stale partial line forever.
    useTranscriptStore.getState().finalizePartial(u.id);
    return;
  }
  const now = Date.now();
  const msg: RoomDataMessage = {
    v: 1,
    kind: "transcript_final",
    id: u.id,
    ts: now,
    from: s.cfg.speaker,
    text,
  };
  const store = useTranscriptStore.getState();
  store.appendMessage(msg);
  store.finalizePartial(u.id);
  try {
    await s.cfg.publish(msg);
  } catch (err) {
    LogBus.warn("whisper", "transcript_final publish failed", {
      error: err instanceof Error ? err.message : String(err),
      id: u.id,
    });
  }
}

function trackUtteranceLatency(
  s: InternalStreamState,
  u: UtteranceContext,
): void {
  if (u.partialDurationsMs.length === 0) return;
  const p50 = percentile(u.partialDurationsMs, 0.5);
  if (p50 > DEGRADED_LATENCY_MS) {
    s.consecutiveDegradedUtterances += 1;
  } else {
    s.consecutiveDegradedUtterances = 0;
  }
  const store = useTranscriptStore.getState();
  if (s.consecutiveDegradedUtterances >= DEGRADED_CONSECUTIVE_LIMIT) {
    if (!store.captionsDegraded) store.setCaptionsDegraded(true);
  } else if (s.consecutiveDegradedUtterances === 0 && store.captionsDegraded) {
    store.setCaptionsDegraded(false);
  }
  LogBus.debug("whisper", "utterance latency", {
    id: u.id,
    p50: Math.round(p50),
    consecutiveDegraded: s.consecutiveDegradedUtterances,
  });
}

// ===== utilities ===========================================================

function concatFrames(frames: Float32Array[], total: number): Float32Array {
  const out = new Float32Array(total);
  let offset = 0;
  for (const f of frames) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

function pickText(result: AsrPipelineResult | AsrPipelineResult[]): string {
  if (Array.isArray(result)) {
    const first = result[0];
    return first ? first.text : "";
  }
  return result.text;
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0] ?? 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * (sorted.length - 1))),
  );
  return sorted[idx] ?? 0;
}

function newUtteranceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
