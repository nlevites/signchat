import type { ParticipantInfo } from "@signchat/contracts";

import { log } from "../logger";
import { mark } from "../diagnostics/mark";

/**
 * ElevenLabs Realtime Speech-to-Text streaming loop, generalised to accept
 * any audio MediaStream (web app feeds a LiveKit RemoteAudioTrack's
 * `mediaStreamTrack`; Bridge feeds a BlackHole 16ch loopback grabbed via
 * `getUserMedia`).
 *
 * Pipeline:
 *   audioStream
 *     → AudioContext(16 kHz)
 *     → MediaStreamSource → AudioWorkletNode (PCM frame chunker, ~100 ms)
 *     → Float32 → Int16 LE → base64
 *     → ElevenLabs Realtime STT WSS (commit_strategy=vad)
 *     → onPartial / onFinal callbacks
 *
 * The host wraps the callbacks however it likes — the web app re-publishes
 * partials as LiveKit data-channel messages and pushes them into Zustand;
 * Bridge appends to a small ring buffer used as the LLM's recentDialog
 * context. The STT module never imports either store directly.
 */

// ===== public surface ======================================================

export interface SttStreamConfig {
  /** Pre-minted single-use WSS URL from /api/elevenlabs/stt-signed-url. */
  signedUrl: string;
  /** Audio source — single mono track is sufficient. */
  audioStream: MediaStream;
  /** ParticipantInfo for the speaker (used in published events). */
  speaker: ParticipantInfo;
  /** Streaming partial callback. Coalesced internally to ~4 Hz max. */
  onPartial?: (event: SttPartialEvent) => void;
  /** Per-utterance final callback. */
  onFinal?: (event: SttFinalEvent) => void;
  /**
   * Recoverable / fatal STT-side error. The host typically surfaces a toast
   * and the stream stops automatically on fatal errors.
   */
  onError?: (event: SttErrorEvent) => void;
  /**
   * Audio AEC/NS/AGC are NOT applied by this module — the input MediaStream
   * is consumed verbatim so callers configure capture as they need (the
   * web app inherits LiveKit's processing; Bridge disables all of them
   * because it captures from a virtual loopback device).
   */
}

export interface SttStream {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SttPartialEvent {
  utteranceId: string;
  text: string;
  ts: number;
  speaker: ParticipantInfo;
}

export interface SttFinalEvent {
  utteranceId: string;
  text: string;
  ts: number;
  speaker: ParticipantInfo;
}

export interface SttErrorEvent {
  /** True for terminal / non-recoverable errors (the stream auto-stops). */
  fatal: boolean;
  /** Server message_type when the source was an ElevenLabs error frame. */
  kind?: string;
  message: string;
}

// ===== tunables ============================================================

// 100 ms @ 16 kHz. Server VAD windows on its own clock, but a steady ~10 Hz
// chunk cadence gives partial_transcript a low end-to-end latency without
// drowning the WSS in tiny frames.
const SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 1600;

// Coalescing gate per turn — fire onPartial only when text changed OR
// ≥250 ms since the last fire. Keeps host renders smooth on heavy speech.
const PUBLISH_COALESCE_MS = 250;

// Cap how many encoded chunks we keep buffered if the WS isn't OPEN yet.
// Server typically accepts within tens of ms; this is just a safety belt
// against runaway memory if the socket stalls during connect.
const MAX_PENDING_CHUNKS = 200;

// Lowercased substrings of known cloud-STT hallucination tokens emitted on
// silence / background-noise input. We match case-insensitively against
// the trimmed transcript and drop anything that's only a hallucination.
const ELEVENLABS_NOISE_TOKENS: readonly string[] = [
  "[blank_audio]",
  "[inaudible]",
  "[music]",
  "[silence]",
  "[no audio]",
  "[noise]",
  "[sound]",
  "(speaking foreign language)",
  "(silence)",
  "thanks for watching",
  "thank you for watching",
  "thank you.",
  "thanks!",
  "bye.",
];

// ===== ElevenLabs Realtime STT message shapes ==============================

interface ElSessionStarted {
  message_type: "session_started";
  session_id: string;
  config?: Record<string, unknown>;
}
interface ElPartialTranscript {
  message_type: "partial_transcript";
  text: string;
}
interface ElCommittedTranscript {
  message_type: "committed_transcript";
  text: string;
}
interface ElCommittedTranscriptWithTimestamps {
  message_type: "committed_transcript_with_timestamps";
  text: string;
}
interface ElError {
  message_type:
    | "error"
    | "auth_error"
    | "quota_exceeded"
    | "commit_throttled"
    | "unaccepted_terms"
    | "rate_limited"
    | "queue_overflow"
    | "resource_exhausted"
    | "session_time_limit_exceeded"
    | "input_error"
    | "chunk_size_exceeded"
    | "insufficient_audio_activity"
    | "transcriber_error";
  error: string;
}

type ElInbound =
  | ElSessionStarted
  | ElPartialTranscript
  | ElCommittedTranscript
  | ElCommittedTranscriptWithTimestamps
  | ElError;

interface ElInputAudioChunk {
  message_type: "input_audio_chunk";
  audio_base_64: string;
  commit: boolean;
  sample_rate: number;
}

// ===== AudioWorklet processor ==============================================

const PCM_FRAME_PROCESSOR_NAME = "signchat-stt-pcm-frame";
// Configured as numberOfOutputs:1 (silent passthrough) rather than a sink.
// Chrome historically does not drive process() on a node whose outputs are
// unconnected; routing this node through a 0-gain destination forces the
// renderer to keep pulling audio from the upstream MediaStreamSource.
// process() leaves outputs[0][0] as the default zeroed buffer so nothing
// is ever audible.
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

// ===== implementation ======================================================

interface InternalStreamState {
  cfg: SttStreamConfig;
  ws: WebSocket | null;
  /**
   * True once `session_started` has been received. Until then, encoded PCM
   * chunks accumulate in `pendingChunks` and flush as soon as the session
   * is live.
   */
  sessionReady: boolean;
  pendingChunks: string[];
  audioCtx: AudioContext | null;
  workletNode: AudioWorkletNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  /**
   * Zero-gain `GainNode` that grounds the worklet's silent output into
   * `audioCtx.destination`. Without this, Chrome may stop driving the
   * worklet's process() callback once it decides the graph has no audible
   * sink.
   */
  groundGain: GainNode | null;
  /**
   * Hidden HTMLAudioElement bound to the same MediaStream the
   * MediaStreamAudioSourceNode reads. Some Chromium builds will not
   * deliver remote-WebRTC track samples into Web Audio unless an
   * <audio> element is concurrently playing the stream. Muted, never
   * connected to the page DOM.
   */
  audioElement: HTMLAudioElement | null;
  /** Document-level one-shot listener that resumes the AudioContext on first user input. */
  gestureCleanup: (() => void) | null;
  /** True after start() succeeded, false again after stop() (or a failure). */
  active: boolean;
  /** Total worklet frames received since start(); used to log a one-shot heartbeat. */
  framesReceived: number;
  /** True once we've emitted the heartbeat log so it only fires once per stream. */
  framesHeartbeatLogged: boolean;
  /** Active utterance state — minted lazily on the first partial after a commit. */
  utterance: ActiveUtterance | null;
}

interface ActiveUtterance {
  id: string;
  /** Most-recent published partial text (used by the coalescing gate). */
  lastPublishedText: string;
  /** Wall-clock ms when we last published a partial for this utterance. */
  lastPublishedAtMs: number;
  /** Has the very first partial for this utterance been published yet? */
  firstPartialPublished: boolean;
}

export function createSttStream(cfg: SttStreamConfig): SttStream {
  const internal: InternalStreamState = {
    cfg,
    ws: null,
    sessionReady: false,
    pendingChunks: [],
    audioCtx: null,
    workletNode: null,
    sourceNode: null,
    groundGain: null,
    audioElement: null,
    gestureCleanup: null,
    active: false,
    framesReceived: 0,
    framesHeartbeatLogged: false,
    utterance: null,
  };

  return {
    start: () => start(internal),
    stop: () => stop(internal),
  };
}

async function start(s: InternalStreamState): Promise<void> {
  if (s.active) return;
  s.active = true;
  try {
    await openWss(s);
    await attachAudioGraph(s);
    log.info("stt", "stream started", {
      audioCtxState: s.audioCtx?.state ?? "(none)",
      sampleRate: s.audioCtx?.sampleRate ?? 0,
      speaker: s.cfg.speaker.identity,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("stt", "stream start failed", { message });
    s.cfg.onError?.({ fatal: true, message });
    await stop(s);
  }
}

async function openWss(s: InternalStreamState): Promise<void> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  const ws = new WebSocket(s.cfg.signedUrl);
  ws.binaryType = "arraybuffer";
  s.ws = ws;

  ws.addEventListener("message", (e) => onWsMessage(s, e));
  ws.addEventListener("error", () => {
    log.warn("stt", "wss error event");
  });
  ws.addEventListener("close", (event) => {
    log.info("stt", "wss closed", {
      code: event.code,
      reason: event.reason || undefined,
    });
    s.sessionReady = false;
  });

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onErr);
      resolve();
    };
    const onErr = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onErr);
      reject(new Error("ElevenLabs STT WSS connect failed"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onErr);
  });

  const safeUrl = s.cfg.signedUrl.split("?")[0] ?? s.cfg.signedUrl;
  log.info("stt", "wss connected", { url: safeUrl });
}

function onWsMessage(s: InternalStreamState, e: MessageEvent): void {
  if (typeof e.data !== "string") return;
  let msg: ElInbound | null = null;
  try {
    msg = JSON.parse(e.data) as ElInbound;
  } catch {
    log.warn("stt", "non-JSON ws frame", {
      preview: e.data.slice(0, 120),
    });
    return;
  }
  if (!msg || typeof msg !== "object" || typeof msg.message_type !== "string") {
    return;
  }
  switch (msg.message_type) {
    case "session_started": {
      s.sessionReady = true;
      log.info("stt", "session started", {
        sessionId: msg.session_id,
      });
      flushPending(s);
      return;
    }
    case "partial_transcript": {
      handlePartial(s, msg.text);
      return;
    }
    case "committed_transcript": {
      handleCommitted(s, msg.text);
      return;
    }
    case "committed_transcript_with_timestamps":
      // Timestamps disabled — the matching committed_transcript already
      // closed the utterance. Ignore to avoid double-finalize.
      return;
    case "error":
    case "auth_error":
    case "quota_exceeded":
    case "commit_throttled":
    case "unaccepted_terms":
    case "rate_limited":
    case "queue_overflow":
    case "resource_exhausted":
    case "session_time_limit_exceeded":
    case "input_error":
    case "chunk_size_exceeded":
    case "insufficient_audio_activity":
    case "transcriber_error": {
      log.error("stt", "server error", {
        kind: msg.message_type,
        error: msg.error,
      });
      s.cfg.onError?.({
        fatal: true,
        kind: msg.message_type,
        message: msg.error,
      });
      void stop(s);
      return;
    }
  }
}

function handlePartial(s: InternalStreamState, rawText: string): void {
  const text = rawText.trim();
  if (text.length === 0) return;
  if (isNoiseHallucination(text)) {
    log.debug("stt", "partial: dropped hallucination", { text });
    return;
  }
  let u = s.utterance;
  if (!u) {
    u = {
      id: newUtteranceId(),
      lastPublishedText: "",
      lastPublishedAtMs: 0,
      firstPartialPublished: false,
    };
    s.utterance = u;
    mark("stt.first-partial", u.id, "start");
  }
  const now = Date.now();
  const sinceLast = now - u.lastPublishedAtMs;
  const textChanged = text !== u.lastPublishedText;
  if (sinceLast < PUBLISH_COALESCE_MS && !textChanged) return;
  u.lastPublishedAtMs = now;
  u.lastPublishedText = text;

  if (!u.firstPartialPublished) {
    mark("stt.first-partial", u.id, "end");
    u.firstPartialPublished = true;
  }

  const event: SttPartialEvent = {
    utteranceId: u.id,
    text,
    ts: now,
    speaker: s.cfg.speaker,
  };
  try {
    s.cfg.onPartial?.(event);
  } catch (err) {
    log.warn("stt", "onPartial threw (ignored)", {
      error: err instanceof Error ? err.message : String(err),
      utteranceId: u.id,
    });
  }
}

function handleCommitted(s: InternalStreamState, rawText: string): void {
  const text = rawText.trim();
  const u = s.utterance;
  // If the server commits without any prior partial (e.g. very short
  // utterance), mint an id on the spot so consumers see a clean final.
  const id = u?.id ?? newUtteranceId();
  s.utterance = null;

  if (text.length === 0 || isNoiseHallucination(text)) {
    log.debug("stt", "committed: dropped", {
      id,
      reason: text.length === 0 ? "empty" : "hallucination",
      text,
    });
    return;
  }
  const now = Date.now();
  mark("stt.committed", id, "start");
  mark("stt.committed", id, "end");
  log.info("stt", "committed", { id, text });

  const event: SttFinalEvent = {
    utteranceId: id,
    text,
    ts: now,
    speaker: s.cfg.speaker,
  };
  try {
    s.cfg.onFinal?.(event);
  } catch (err) {
    log.warn("stt", "onFinal threw (ignored)", {
      error: err instanceof Error ? err.message : String(err),
      utteranceId: id,
    });
  }
}

async function attachAudioGraph(s: InternalStreamState): Promise<void> {
  const stream = s.cfg.audioStream;
  if (stream.getAudioTracks().length === 0) {
    throw new Error("audioStream has no audio tracks");
  }

  const audioElement = document.createElement("audio");
  audioElement.muted = true;
  audioElement.autoplay = true;
  audioElement.setAttribute("playsinline", "");
  audioElement.srcObject = stream;
  s.audioElement = audioElement;
  try {
    await audioElement.play();
  } catch (playErr) {
    log.debug("stt", "audio element play() rejected", {
      error: playErr instanceof Error ? playErr.message : String(playErr),
    });
  }

  const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  s.audioCtx = audioCtx;

  await audioCtx.audioWorklet.addModule(getWorkletModuleUrl());
  const workletNode = new AudioWorkletNode(
    audioCtx,
    PCM_FRAME_PROCESSOR_NAME,
    {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
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

  const groundGain = audioCtx.createGain();
  groundGain.gain.value = 0;
  workletNode.connect(groundGain).connect(audioCtx.destination);
  s.groundGain = groundGain;

  if (audioCtx.sampleRate !== SAMPLE_RATE) {
    log.warn("stt", "AudioContext sample rate mismatch", {
      requested: SAMPLE_RATE,
      actual: audioCtx.sampleRate,
    });
  }

  await tryResumeAudioCtx(s);
}

async function tryResumeAudioCtx(s: InternalStreamState): Promise<void> {
  const ctx = s.audioCtx;
  if (!ctx) return;
  const stateOf = (c: AudioContext): string => c.state;
  if (stateOf(ctx) === "running") return;
  try {
    await ctx.resume();
  } catch (err) {
    log.debug("stt", "audioctx initial resume rejected", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  if (stateOf(ctx) === "running") {
    log.info("stt", "audioctx resumed", { via: "immediate" });
    return;
  }
  log.info("stt", "audioctx suspended; awaiting user gesture", {
    state: stateOf(ctx),
  });
  if (typeof document === "undefined") return;
  const onGesture = () => {
    void ctx
      .resume()
      .then(() => {
        if (stateOf(ctx) === "running") {
          log.info("stt", "audioctx resumed", { via: "gesture" });
        }
      })
      .catch((err) => {
        log.warn("stt", "audioctx gesture resume failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
  };
  const cleanup = () => {
    document.removeEventListener("pointerdown", onGesture, true);
    document.removeEventListener("keydown", onGesture, true);
    document.removeEventListener("touchstart", onGesture, true);
    s.gestureCleanup = null;
  };
  document.addEventListener("pointerdown", onGesture, true);
  document.addEventListener("keydown", onGesture, true);
  document.addEventListener("touchstart", onGesture, true);
  s.gestureCleanup = cleanup;
}

function onFrameFromWorklet(s: InternalStreamState, frame: Float32Array): void {
  if (!s.active) return;
  s.framesReceived += 1;
  if (!s.framesHeartbeatLogged && s.framesReceived >= 10) {
    s.framesHeartbeatLogged = true;
    log.info("stt", "frames received", {
      count: s.framesReceived,
      audioCtxState: s.audioCtx?.state ?? "(none)",
    });
  }
  const base64 = float32ToPcm16Base64(frame);
  if (!s.sessionReady || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
    if (s.pendingChunks.length >= MAX_PENDING_CHUNKS) {
      s.pendingChunks.shift();
    }
    s.pendingChunks.push(base64);
    return;
  }
  sendChunk(s, base64);
}

function flushPending(s: InternalStreamState): void {
  if (s.pendingChunks.length === 0) return;
  if (!s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  const queued = s.pendingChunks.splice(0, s.pendingChunks.length);
  for (const b64 of queued) sendChunk(s, b64);
}

function sendChunk(s: InternalStreamState, base64: string): void {
  const ws = s.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload: ElInputAudioChunk = {
    message_type: "input_audio_chunk",
    audio_base_64: base64,
    commit: false,
    sample_rate: SAMPLE_RATE,
  };
  try {
    ws.send(JSON.stringify(payload));
  } catch (err) {
    log.warn("stt", "ws send failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function stop(s: InternalStreamState): Promise<void> {
  s.active = false;
  s.pendingChunks.length = 0;
  if (s.gestureCleanup) {
    try {
      s.gestureCleanup();
    } catch {
      // ignore
    }
    s.gestureCleanup = null;
  }
  if (s.workletNode) {
    try {
      s.workletNode.port.onmessage = null;
      s.workletNode.disconnect();
    } catch {
      // ignore
    }
    s.workletNode = null;
  }
  if (s.groundGain) {
    try {
      s.groundGain.disconnect();
    } catch {
      // ignore
    }
    s.groundGain = null;
  }
  if (s.sourceNode) {
    try {
      s.sourceNode.disconnect();
    } catch {
      // ignore
    }
    s.sourceNode = null;
  }
  if (s.audioElement) {
    try {
      s.audioElement.pause();
      s.audioElement.srcObject = null;
    } catch {
      // ignore
    }
    s.audioElement = null;
  }
  if (s.audioCtx) {
    try {
      await s.audioCtx.close();
    } catch {
      // ignore
    }
    s.audioCtx = null;
  }
  if (s.ws) {
    try {
      // Best-effort manual commit to flush any tail audio the server
      // hadn't VAD-cut yet. Empty audio + commit:true is the documented
      // pattern; if the WS isn't open we just close.
      if (s.ws.readyState === WebSocket.OPEN) {
        s.ws.send(
          JSON.stringify({
            message_type: "input_audio_chunk",
            audio_base_64: "",
            commit: true,
            sample_rate: SAMPLE_RATE,
          } satisfies ElInputAudioChunk),
        );
        s.ws.close(1000, "client done");
      }
    } catch {
      // ignore
    }
    s.ws = null;
  }
  s.sessionReady = false;
  s.utterance = null;
  s.framesReceived = 0;
  s.framesHeartbeatLogged = false;
  log.debug("stt", "stream stopped");
}

// ===== utilities ===========================================================

function float32ToPcm16Base64(frame: Float32Array): string {
  const out = new Uint8Array(frame.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < frame.length; i += 1) {
    let sample = frame[i] ?? 0;
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    const intSample = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, intSample, true);
  }
  return uint8ToBase64(out);
}

function uint8ToBase64(bytes: Uint8Array): string {
  // btoa expects a binary string; chunk to avoid call-stack blowups on
  // very large buffers (FRAME_SAMPLES=1600 → 3200 bytes is well under the
  // 64 KB chunk used here, but keep the chunked path for safety).
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function isNoiseHallucination(text: string): boolean {
  const stripped = text.trim().toLowerCase();
  if (stripped.length === 0) return true;
  if (stripped === "you" || stripped === "you.") return true;
  for (const token of ELEVENLABS_NOISE_TOKENS) {
    if (stripped === token) return true;
    if (stripped.replace(/[.\s\-—]+$/g, "") === token) return true;
  }
  return false;
}

function newUtteranceId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
