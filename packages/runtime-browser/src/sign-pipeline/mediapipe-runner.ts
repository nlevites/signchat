import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  PoseLandmarker,
  type Category,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
  type NormalizedLandmark as MpNormalizedLandmark,
  type PoseLandmarkerResult,
} from "@mediapipe/tasks-vision";
import { log } from "../logger";
import { mark } from "../diagnostics/mark";
import type { HandResult, NormalizedLandmark } from "./landmark-assembly";
import { installMediaPipeLogFilter } from "./mp-log-filter";

/**
 * MediaPipe Tasks Vision wiring: a single VisionRunner owns three detectors
 * (FaceLandmarker, HandLandmarker, PoseLandmarker), all configured for VIDEO
 * mode and fed by an HTMLVideoElement.
 *
 * Per ARCHITECTURE.md §5.4: face + hands + pose run on the main thread, fed
 * by the local Track.Source.Camera MediaStreamTrack BEFORE any LiveKit
 * encode/decode.
 *
 * The asset paths and CDN come from the official MediaPipe model zoo:
 *   https://developers.google.com/mediapipe/solutions/vision/{face,hand,pose}_landmarker
 */

const MEDIAPIPE_VERSION = "0.10.17";

const WASM_BASE =
  `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`;

const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const HAND_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export interface VisionFrame {
  /** First 478 entries; assembleFrame() truncates to 468. Null when no face detected. */
  face: NormalizedLandmark[] | null;
  hands: HandResult[];
  pose: NormalizedLandmark[] | null;
  /** performance.now() at detect call. */
  ts: number;
}

export interface VisionRunner {
  /** Run all three detectors on the current video frame. */
  detect(video: HTMLVideoElement, ts: number): VisionFrame;
  close(): void;
}

interface CreateRunnerOptions {
  /** GPU delegate where available; falls back to CPU on platforms without WebGL2. */
  preferGpu?: boolean;
  /**
   * Maximum number of hands to detect. The workbench targets 1:1 video chat;
   * the architecture's 21x2 hand layout supports both signing hands.
   */
  numHands?: number;
}

/**
 * Boot the FilesetResolver + three landmarker tasks. Runs on the browser main
 * thread; awaiting this resolves an object that synchronously runs all three
 * detectors per call to detect().
 */
export async function createVisionRunner(
  options: CreateRunnerOptions = {},
): Promise<VisionRunner> {
  if (typeof window === "undefined") {
    throw new Error("createVisionRunner() called outside the browser");
  }
  // Filter MP's INFO/W console.error spam before any task loads.
  installMediaPipeLogFilter();
  const preferGpu = options.preferGpu ?? true;
  const numHands = options.numHands ?? 2;
  const delegate: "GPU" | "CPU" = preferGpu ? "GPU" : "CPU";

  log.info("mp", `loading FilesetResolver from CDN`, { wasmBase: WASM_BASE });
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);

  log.info("mp", "creating face / hand / pose landmarkers");
  const startedAt = performance.now();
  const [face, hand, pose] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numFaces: 1,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    }),
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numHands,
    }),
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
      outputSegmentationMasks: false,
    }),
  ]);
  log.info("mp", `landmarkers ready (${Math.round(performance.now() - startedAt)}ms)`, {
    delegate,
    numHands,
  });

  return {
    detect(video, ts) {
      const probeId = ts.toString(36);
      mark("mp.detect", probeId, "start");
      let faceRes: FaceLandmarkerResult | null = null;
      let handRes: HandLandmarkerResult | null = null;
      let poseRes: PoseLandmarkerResult | null = null;
      try {
        faceRes = face.detectForVideo(video, ts);
        handRes = hand.detectForVideo(video, ts);
        poseRes = pose.detectForVideo(video, ts);
      } catch (err) {
        log.error("mp", "detectForVideo threw", { err: String(err) });
        mark("mp.detect", probeId, "end");
        return { face: null, hands: [], pose: null, ts };
      }
      mark("mp.detect", probeId, "end");
      return {
        ts,
        face: extractFace(faceRes),
        hands: extractHands(handRes),
        pose: extractPose(poseRes),
      };
    },
    close() {
      try {
        face.close();
        hand.close();
        pose.close();
      } catch (err) {
        log.warn("mp", "close failed", { err: String(err) });
      }
    },
  };
}

// ===== detector-result extractors ============================================

function toNormalizedLandmarks(
  src: ReadonlyArray<MpNormalizedLandmark> | undefined,
): NormalizedLandmark[] | null {
  if (!src || src.length === 0) return null;
  const out: NormalizedLandmark[] = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const lm = src[i] as MpNormalizedLandmark;
    out[i] = { x: lm.x, y: lm.y, z: lm.z };
  }
  return out;
}

function extractFace(res: FaceLandmarkerResult | null): NormalizedLandmark[] | null {
  if (!res || !res.faceLandmarks || res.faceLandmarks.length === 0) return null;
  return toNormalizedLandmarks(res.faceLandmarks[0]);
}

function extractPose(res: PoseLandmarkerResult | null): NormalizedLandmark[] | null {
  if (!res || !res.landmarks || res.landmarks.length === 0) return null;
  return toNormalizedLandmarks(res.landmarks[0]);
}

function extractHands(res: HandLandmarkerResult | null): HandResult[] {
  if (!res || !res.landmarks || res.landmarks.length === 0) return [];
  const out: HandResult[] = [];
  for (let i = 0; i < res.landmarks.length; i++) {
    const lm = res.landmarks[i];
    const handedness = pickHandedness(res.handedness?.[i]);
    if (!lm || !handedness) continue;
    out.push({
      handedness: handedness.label,
      landmarks: toNormalizedLandmarks(lm) ?? [],
      score: handedness.score,
    });
  }
  return out;
}

function pickHandedness(
  cats: ReadonlyArray<Category> | undefined,
): { label: "Left" | "Right"; score: number } | null {
  if (!cats || cats.length === 0) return null;
  const top = cats[0];
  if (!top) return null;
  if (top.categoryName === "Left") return { label: "Left", score: top.score };
  if (top.categoryName === "Right") return { label: "Right", score: top.score };
  return null;
}
