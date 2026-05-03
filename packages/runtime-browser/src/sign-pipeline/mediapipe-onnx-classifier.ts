import { log } from "../logger";
import { mark } from "../diagnostics/mark";
import {
  type Classifier,
  type ClassifierResult,
  type ClassifierState,
} from "./classifier";
import {
  assembleFrame,
  FrameRingBuffer,
  stackWindow,
} from "./landmark-assembly";
import {
  fetchSignLabels,
  LABELS_URL,
  softmax,
  topK as computeTopK,
  type SignLabels,
} from "./labels";
import {
  ASL_MODEL_URL,
  createAslSession,
  loadOrt,
  type OrtInferenceSession,
} from "./onnx-session";
import {
  createVisionRunner,
  type VisionRunner,
  type VisionFrame,
} from "./mediapipe-runner";

/**
 * Live ASL sign classifier wiring everything in lib/sign-pipeline together.
 *
 *   getUserMedia(camera)
 *     -> hidden HTMLVideoElement
 *     -> requestVideoFrameCallback (rAF fallback)
 *        -> VisionRunner.detect()         [mp.detect]
 *        -> assembleFrame() into ring     [mp.assemble]
 *     -> setInterval(inferenceIntervalMs)
 *        -> stackWindow(ring) -> Tensor   [ort.tensor]
 *        -> session.run()                 [ort.run]
 *        -> softmax + topK                [ort.topk]
 *        -> ClassifierResult callbacks
 *
 * Implements the Classifier interface from ./classifier so the Sign capture
 * pane swaps it in for ScriptedClassifier with no other changes.
 */

export interface ClassifierConfig {
  /** Inference cadence in milliseconds. ARCHITECTURE.md §9.2 default = 500. */
  inferenceIntervalMs: number;
  /** Window size in frames; max 48 per ARCHITECTURE.md §5.4. */
  windowFrames: number;
  /** Top-K predictions per result. */
  topK: number;
  /** Skip inference until ring has at least this many frames. */
  minFramesBeforeRun: number;
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  inferenceIntervalMs: 500,
  windowFrames: 48,
  topK: 3,
  minFramesBeforeRun: 8,
};

export interface MediaPipeOnnxClassifierOptions {
  /** Optional config override; merged on top of DEFAULT_CLASSIFIER_CONFIG. */
  config?: Partial<ClassifierConfig>;
  /** Where to publish the camera stream so the pane can render a preview. */
  onStream?: (stream: MediaStream) => void;
  /** Per-frame landmark callback (post-assembly), useful for the dot overlay. */
  onFrame?: (frame: VisionFrame) => void;
  /** Reports model download progress (received, total). */
  onModelProgress?: (received: number, total: number | null) => void;
  /** Override the model URL (defaults to /models/asl-signs/asl-signs.onnx). */
  modelUrl?: string;
  /**
   * Override the labels URL (defaults to
   * /models/asl-signs/sign_to_prediction_index_map.json). Useful when the
   * static assets aren't served from the renderer's origin — Bridge points
   * this at the apps/web origin so it can reuse the same JSON file.
   */
  labelsUrl?: string;
  /** getUserMedia constraints. Defaults to 640x480 video, no audio. */
  videoConstraints?: MediaStreamConstraints["video"];
  /**
   * Pre-existing camera stream to consume instead of calling getUserMedia.
   * When provided, the classifier shares ownership: it will not stop the
   * tracks on cleanup, leaving lifecycle to the caller (e.g. when the
   * camera track is owned by LiveKit's LocalVideoTrack and re-acquiring
   * via getUserMedia would conflict with LiveKit's track ownership).
   */
  stream?: MediaStream;
}

const DEFAULT_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 640 },
  height: { ideal: 480 },
  frameRate: { ideal: 30, max: 30 },
  facingMode: "user",
};

export class MediaPipeOnnxClassifier implements Classifier {
  private readonly cfg: ClassifierConfig;
  private readonly options: MediaPipeOnnxClassifierOptions;
  private readonly resultListeners = new Set<(r: ClassifierResult) => void>();
  private readonly stateListeners = new Set<
    (state: ClassifierState, error?: Error) => void
  >();

  private currentState: ClassifierState = "idle";
  private ring: FrameRingBuffer;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private runner: VisionRunner | null = null;
  private session: OrtInferenceSession | null = null;
  private labels: SignLabels | null = null;
  private inferTimer: ReturnType<typeof setInterval> | null = null;
  private rafId: number | null = null;
  private vfcId: number | null = null;
  private inferring = false;
  private destroyed = false;
  /** Set by document.visibilitychange when the tab is hidden. */
  private paused = false;
  private visibilityHandler: (() => void) | null = null;

  constructor(options: MediaPipeOnnxClassifierOptions = {}) {
    this.cfg = { ...DEFAULT_CLASSIFIER_CONFIG, ...(options.config ?? {}) };
    this.options = options;
    this.ring = new FrameRingBuffer(this.cfg.windowFrames);
  }

  state(): ClassifierState {
    return this.currentState;
  }

  onResult(cb: (result: ClassifierResult) => void): () => void {
    this.resultListeners.add(cb);
    return () => {
      this.resultListeners.delete(cb);
    };
  }

  onStateChange(
    cb: (state: ClassifierState, error?: Error) => void,
  ): () => void {
    this.stateListeners.add(cb);
    return () => {
      this.stateListeners.delete(cb);
    };
  }

  async start(): Promise<void> {
    if (this.currentState === "running" || this.currentState === "starting") return;
    if (this.destroyed) {
      throw new Error("classifier was stopped permanently; create a new instance");
    }
    this.transition("starting");
    try {
      log.info("classifier", "starting MediaPipeOnnxClassifier", { config: this.cfg });

      // 1. Boot ort + model + labels in parallel with MP runner + camera.
      const t0 = performance.now();
      const [labels, session, runner, stream] = await Promise.all([
        this.loadLabels(),
        this.loadSession(),
        createVisionRunner(),
        this.openCamera(),
      ]);
      this.labels = labels;
      this.session = session;
      this.runner = runner;
      this.stream = stream;
      this.options.onStream?.(stream);
      log.info(
        "classifier",
        `boot complete in ${Math.round(performance.now() - t0)}ms`,
      );

      // 2. Hidden video element bound to the stream (browser must paint frames
      //    for MP detect to work; we don't need it visible).
      this.video = await this.attachStreamToVideo(stream);

      // 3. Per-frame loop (rVFC if available, rAF fallback) for MP detection.
      this.startFrameLoop();

      // 4. Periodic inference timer.
      this.inferTimer = setInterval(() => {
        void this.runInferenceOnce();
      }, this.cfg.inferenceIntervalMs);

      // 5. Pause inference when the tab is hidden (saves CPU + battery).
      this.installVisibilityHandler();

      this.transition("running");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log.error("classifier", "start failed", { error: error.message });
      this.transition("error", error);
      await this.cleanup();
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.currentState === "stopped" || this.currentState === "idle") {
      this.transition("stopped");
      return;
    }
    log.info("classifier", "stopping MediaPipeOnnxClassifier");
    await this.cleanup();
    this.transition("stopped");
  }

  /** Update inference cadence at runtime (Phase 5c slider). */
  setInferenceIntervalMs(ms: number): void {
    this.cfg.inferenceIntervalMs = Math.max(50, Math.floor(ms));
    if (this.currentState === "running" && this.inferTimer !== null) {
      clearInterval(this.inferTimer);
      this.inferTimer = setInterval(() => {
        void this.runInferenceOnce();
      }, this.cfg.inferenceIntervalMs);
    }
  }

  /** Read the active inference cadence. */
  getInferenceIntervalMs(): number {
    return this.cfg.inferenceIntervalMs;
  }

  /** Whether per-window inference is currently paused (e.g. tab hidden). */
  isPaused(): boolean {
    return this.paused;
  }

  // ----- internal --------------------------------------------------------

  private transition(next: ClassifierState, error?: Error): void {
    this.currentState = next;
    for (const cb of this.stateListeners) {
      try {
        cb(next, error);
      } catch {
        // swallow
      }
    }
  }

  private async loadLabels(): Promise<SignLabels> {
    return fetchSignLabels(this.options.labelsUrl ?? LABELS_URL);
  }

  private async loadSession(): Promise<OrtInferenceSession> {
    return createAslSession({
      modelUrl: this.options.modelUrl ?? ASL_MODEL_URL,
      ...(this.options.onModelProgress
        ? { onProgress: this.options.onModelProgress }
        : {}),
    });
  }

  private async openCamera(): Promise<MediaStream> {
    if (this.options.stream) {
      return this.options.stream;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("getUserMedia not available");
    }
    const video = this.options.videoConstraints ?? DEFAULT_VIDEO_CONSTRAINTS;
    return navigator.mediaDevices.getUserMedia({ video, audio: false });
  }

  private async attachStreamToVideo(stream: MediaStream): Promise<HTMLVideoElement> {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onError);
        resolve();
      };
      const onError = () => {
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("error", onError);
        reject(new Error("video element error"));
      };
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("error", onError);
    });
    try {
      await video.play();
    } catch {
      // some browsers reject; loadeddata is enough for detectForVideo
    }
    return video;
  }

  private startFrameLoop(): void {
    const onFrame = (now: number): void => {
      if (this.currentState !== "running" && this.currentState !== "starting") return;
      const video = this.video;
      const runner = this.runner;
      if (!video || !runner) return;
      // Tab hidden: skip detection (MediaPipe is CPU-heavy) but keep the
      // video element subscribed to the stream so resume is instant.
      if (this.paused) {
        this.queueNextFrame();
        return;
      }
      // MP requires a non-zero readyState; skip frames before HAVE_CURRENT_DATA.
      if (video.readyState < 2) {
        this.queueNextFrame();
        return;
      }
      try {
        const probeId = now.toFixed(0);
        const visionFrame = runner.detect(video, now);
        mark("mp.assemble", probeId, "start");
        const flat = assembleFrame(visionFrame);
        mark("mp.assemble", probeId, "end");
        this.ring.push(flat);
        this.options.onFrame?.(visionFrame);
      } catch (err) {
        log.warn("classifier", "frame loop error", { err: String(err) });
      }
      this.queueNextFrame();
    };
    const queueRequestAF = () => {
      this.rafId = requestAnimationFrame((t) => {
        onFrame(t);
      });
    };
    const videoEl = this.video;
    if (videoEl && typeof videoEl.requestVideoFrameCallback === "function") {
      const tick = (): void => {
        onFrame(performance.now());
      };
      this.queueNextFrame = () => {
        if (!this.video) return;
        const cb = this.video.requestVideoFrameCallback;
        if (typeof cb === "function") {
          this.vfcId = cb.call(this.video, tick);
        } else {
          queueRequestAF();
        }
      };
    } else {
      this.queueNextFrame = queueRequestAF;
    }
    this.queueNextFrame();
  }

  private queueNextFrame: () => void = () => {};

  private async runInferenceOnce(): Promise<void> {
    if (this.inferring) return;
    if (this.paused) return;
    if (this.currentState !== "running") return;
    if (!this.session || !this.labels) return;
    if (this.ring.size() < this.cfg.minFramesBeforeRun) return;
    this.inferring = true;
    const probeId = performance.now().toString(36);
    try {
      const ort = await loadOrt();
      const frames = this.ring.snapshot();
      const t = frames.length;
      mark("ort.tensor", probeId, "start");
      const flat = stackWindow(frames);
      const tensor = new ort.Tensor("float32", flat, [t, 543, 3]);
      mark("ort.tensor", probeId, "end");

      const inputName = this.session.inputNames[0];
      const outputName = this.session.outputNames[0];
      if (!inputName || !outputName) {
        throw new Error("session missing input/output names");
      }
      mark("ort.run", probeId, "start");
      const outputs = await this.session.run({ [inputName]: tensor });
      mark("ort.run", probeId, "end");
      const logitsTensor = outputs[outputName];
      if (!logitsTensor || !(logitsTensor.data instanceof Float32Array)) {
        throw new Error("unexpected output tensor type");
      }
      const logits = logitsTensor.data;
      mark("ort.topk", probeId, "start");
      const probs = softmax(logits);
      const top = computeTopK(probs, this.labels.indexToLabel, this.cfg.topK);
      mark("ort.topk", probeId, "end");

      const result: ClassifierResult = {
        ts: performance.now(),
        top: top.map((entry) => ({ label: entry.label, score: entry.score })),
      };
      for (const cb of this.resultListeners) {
        try {
          cb(result);
        } catch (err) {
          log.warn("classifier", "result listener threw", { err: String(err) });
        }
      }
    } catch (err) {
      log.error("classifier", "inference failed", { err: String(err) });
    } finally {
      this.inferring = false;
    }
  }

  private installVisibilityHandler(): void {
    if (typeof document === "undefined") return;
    if (this.visibilityHandler !== null) return;
    const handler = () => {
      const hidden = document.hidden;
      this.paused = hidden;
      log.debug("classifier", `tab visibility ${hidden ? "hidden" : "visible"}`, {
        paused: this.paused,
      });
    };
    document.addEventListener("visibilitychange", handler);
    this.visibilityHandler = handler;
    // Initial sync.
    this.paused = document.hidden;
  }

  private async cleanup(): Promise<void> {
    if (this.visibilityHandler && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
      this.visibilityHandler = null;
    }
    if (this.inferTimer !== null) {
      clearInterval(this.inferTimer);
      this.inferTimer = null;
    }
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.video && this.vfcId !== null) {
      // No standardized cancel for rVFC across browsers; setting state to
      // not-running causes our onFrame to no-op, and we drop the video element.
      this.vfcId = null;
    }
    this.runner?.close();
    this.runner = null;
    if (this.session && typeof this.session.release === "function") {
      try {
        await this.session.release();
      } catch (err) {
        log.warn("classifier", "session.release threw", { err: String(err) });
      }
    }
    this.session = null;
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.stream) {
      // Don't stop tracks we don't own (caller-provided stream stays alive).
      if (!this.options.stream) {
        for (const track of this.stream.getTracks()) track.stop();
      }
      this.stream = null;
    }
    this.ring.clear();
    this.destroyed = true;
  }
}
