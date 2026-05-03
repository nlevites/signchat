import {
  FaceLandmarker,
  GestureRecognizer,
  PoseLandmarker,
  FilesetResolver,
} from "@mediapipe/tasks-vision";

const WASM_BASE_URL =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.17/wasm";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task";
const GESTURE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/latest/gesture_recognizer.task";
const POSE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task";

export interface MediaPipeBundle {
  face: FaceLandmarker;
  gesture: GestureRecognizer;
  pose: PoseLandmarker;
}

export async function loadMediaPipe(): Promise<MediaPipeBundle> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE_URL);
  const [face, gesture, pose] = await Promise.all([
    FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: FACE_MODEL_URL },
      runningMode: "VIDEO",
      numFaces: 1,
    }),
    GestureRecognizer.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: GESTURE_MODEL_URL },
      runningMode: "VIDEO",
      numHands: 2,
    }),
    PoseLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL },
      runningMode: "VIDEO",
      numPoses: 1,
    }),
  ]);
  return { face, gesture, pose };
}
