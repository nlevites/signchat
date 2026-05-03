/**
 * Convert MediaPipe Tasks Vision detector results into the (543, 3) per-frame
 * landmark layout the asl-signs ONNX classifier expects.
 *
 * Kaggle row order (matches the model's training-time layout):
 *   [Face(468)] [LHand(21)] [Pose(33)] [RHand(21)] = 543 rows
 *
 * Missing landmarks are NaN (NOT 0). The model's baked-in preprocessing
 * normalizes finite values per clip and treats NaN as "not detected"; zeroing
 * would silently move "not detected" into the data distribution.
 *
 * Notes on conventions, derived from ARCHITECTURE.md §5.4 + the asl-signs
 * Kaggle docs:
 *
 * - x, y are normalized image coords in [0, 1]. MediaPipe Tasks Vision returns
 *   them in the same space as the older Holistic, no rescaling needed.
 * - z is depth in image-width units, smaller = closer to camera. Tasks Vision
 *   matches this convention.
 * - Face: Tasks Vision FaceLandmarker returns 478 landmarks (468 face + 10
 *   iris). The first 468 indices correspond to the older Holistic layout the
 *   model was trained against; we truncate to those 468.
 * - Hands: handedness label "Left" maps to the LHand block (rows 468..488)
 *   and "Right" maps to RHand (522..542). MediaPipe and Kaggle both label
 *   relative to the user, not the camera, so they line up.
 * - Pose: 33 landmarks; both new and old MediaPipe pose models share these
 *   indices.
 *
 * Pure function. No DOM. Safe to import from the workbench Node smoke.
 */

export const N_FACE = 468;
export const N_LHAND = 21;
export const N_POSE = 33;
export const N_RHAND = 21;
export const N_TOTAL = N_FACE + N_LHAND + N_POSE + N_RHAND; // 543
export const FRAME_FLOATS = N_TOTAL * 3; // 1629

export const FACE_OFFSET = 0;
export const LHAND_OFFSET = N_FACE;
export const POSE_OFFSET = N_FACE + N_LHAND;
export const RHAND_OFFSET = N_FACE + N_LHAND + N_POSE;

export interface NormalizedLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export interface HandResult {
  /** "Left" or "Right" relative to the user. */
  handedness: "Left" | "Right";
  /** 21 landmarks per MediaPipe HandLandmarker. */
  landmarks: ReadonlyArray<NormalizedLandmark>;
  /** Confidence score, used to break ties when both hands return same handedness. */
  score?: number;
}

export interface FrameInput {
  /** First 468 entries used; extras (e.g. iris from Tasks Vision) ignored. */
  face: ReadonlyArray<NormalizedLandmark> | null;
  hands: ReadonlyArray<HandResult>;
  pose: ReadonlyArray<NormalizedLandmark> | null;
}

/**
 * Returns a fresh Float32Array of length 1629 (= 543 * 3) initialized to NaN.
 * Caller mutates in place.
 */
export function newFrameBuffer(): Float32Array {
  const buf = new Float32Array(FRAME_FLOATS);
  buf.fill(Number.NaN);
  return buf;
}

/** Number of finite (non-NaN) x-values across the frame. Diagnostics-only. */
export function countDetectedPoints(frame: Float32Array): number {
  let count = 0;
  for (let i = 0; i < N_TOTAL; i++) {
    const x = frame[i * 3];
    if (Number.isFinite(x)) count++;
  }
  return count;
}

/**
 * Write a section of `count` landmarks into `frame` starting at `rowOffset`.
 * Pads with NaN if `landmarks` is shorter than `count`. Rows beyond `count`
 * are left untouched (already NaN from newFrameBuffer).
 */
function writeSection(
  frame: Float32Array,
  rowOffset: number,
  count: number,
  landmarks: ReadonlyArray<NormalizedLandmark> | null,
): void {
  if (!landmarks || landmarks.length === 0) return;
  const limit = Math.min(count, landmarks.length);
  for (let i = 0; i < limit; i++) {
    const lm = landmarks[i] as NormalizedLandmark;
    const base = (rowOffset + i) * 3;
    frame[base] = lm.x;
    frame[base + 1] = lm.y;
    frame[base + 2] = lm.z;
  }
}

/** Pick the higher-score hand when two results share the same handedness. */
function pickHand(
  hands: ReadonlyArray<HandResult>,
  side: "Left" | "Right",
): HandResult | null {
  let best: HandResult | null = null;
  for (const h of hands) {
    if (h.handedness !== side) continue;
    if (best === null) {
      best = h;
      continue;
    }
    const a = best.score ?? 1;
    const b = h.score ?? 1;
    if (b > a) best = h;
  }
  return best;
}

/**
 * Assemble one (543, 3) frame from MediaPipe results.
 * Output layout: [Face(468), LHand(21), Pose(33), RHand(21)] flat row-major.
 */
export function assembleFrame(input: FrameInput): Float32Array {
  const frame = newFrameBuffer();
  // Face: truncate to first 468 (Tasks Vision returns 478 with iris).
  if (input.face && input.face.length > 0) {
    writeSection(frame, FACE_OFFSET, N_FACE, input.face);
  }
  // Hands: bin by handedness, prefer higher-score result on ties.
  const lhand = pickHand(input.hands, "Left");
  const rhand = pickHand(input.hands, "Right");
  if (lhand) writeSection(frame, LHAND_OFFSET, N_LHAND, lhand.landmarks);
  if (rhand) writeSection(frame, RHAND_OFFSET, N_RHAND, rhand.landmarks);
  // Pose: full 33.
  if (input.pose && input.pose.length > 0) {
    writeSection(frame, POSE_OFFSET, N_POSE, input.pose);
  }
  return frame;
}

// === window builder ==========================================================

/**
 * Stack `frames` into a flat Float32Array of length T*543*3 in row-major order.
 * Throws if any frame has the wrong length. Caller passes the result to the
 * ort Tensor constructor with dims `[frames.length, 543, 3]`.
 */
export function stackWindow(frames: ReadonlyArray<Float32Array>): Float32Array {
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as Float32Array;
    if (f.length !== FRAME_FLOATS) {
      throw new Error(
        `frame ${i} has length ${f.length}, expected ${FRAME_FLOATS}`,
      );
    }
  }
  const out = new Float32Array(frames.length * FRAME_FLOATS);
  for (let i = 0; i < frames.length; i++) {
    out.set(frames[i] as Float32Array, i * FRAME_FLOATS);
  }
  return out;
}

// === simple ring buffer ======================================================

/**
 * Bounded queue of frames keeping at most `capacity` most recent. Push is O(1).
 * `snapshot()` returns frames in chronological order (oldest first).
 */
export class FrameRingBuffer {
  private items: Float32Array[] = [];
  constructor(public readonly capacity: number) {
    if (capacity <= 0) throw new Error(`capacity must be positive, got ${capacity}`);
  }

  push(frame: Float32Array): void {
    if (frame.length !== FRAME_FLOATS) {
      throw new Error(`frame length ${frame.length}, expected ${FRAME_FLOATS}`);
    }
    this.items.push(frame);
    if (this.items.length > this.capacity) {
      this.items.shift();
    }
  }

  size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items = [];
  }

  /** Chronological snapshot, oldest first. Cheap (returns the live array slice). */
  snapshot(): ReadonlyArray<Float32Array> {
    return this.items.slice();
  }
}
