import { useEffect, useRef, useState } from "react";
import { log } from "@signchat/runtime-browser/logger";
import { MediaPipeOnnxClassifier } from "@signchat/runtime-browser/sign-pipeline/mediapipe-onnx-classifier";
import type {
  ClassifierResult,
  ClassifierState,
} from "@signchat/runtime-browser/sign-pipeline/classifier";
import type { VisionFrame } from "@signchat/runtime-browser/sign-pipeline/mediapipe-runner";

/**
 * Sign labels that the classifier must never surface in its top-K result.
 * Mirrors the list in apps/web/components/room/DeafSession.tsx so Bridge
 * and the web app behave identically. Names must match the JSON keys in
 * apps/web/public/models/asl-signs/sign_to_prediction_index_map.json
 * exactly (case-sensitive).
 */
const BLOCKED_SIGN_LABELS = new Set<string>(["giraffe", "drop"]);

export interface UseClassifierOptions {
  cameraDeviceId: string;
  /**
   * Origin that hosts the classifier static assets — `apps/web` in dev
   * (default `http://localhost:3000`) or signchat.org in production. Bridge
   * appends `/models/asl-signs/asl-signs.onnx` and the labels JSON to this.
   */
  modelOrigin: string;
  /** Where to publish ClassifierResults. Stable identity preferred. */
  onResult(result: ClassifierResult): void;
  /** Where to publish VisionFrames for the overlay. */
  onFrame(frame: VisionFrame): void;
  /** Where to surface lifecycle errors. */
  onError(message: string): void;
}

interface ClassifierLifecycle {
  stream: MediaStream | null;
  state: ClassifierState;
}

/**
 * Acquires the user's webcam by deviceId and runs the MediaPipe + ONNX
 * sign classifier against it. Re-instantiates the classifier when the
 * camera id changes.
 *
 * Camera multi-tenancy on macOS lets Zoom and Bridge share the same
 * webcam concurrently, so this hook just calls `getUserMedia` directly
 * — there is no LiveKit track to borrow from like the web app's
 * DeafSession does.
 */
export function useClassifier(
  options: UseClassifierOptions,
): ClassifierLifecycle {
  const { cameraDeviceId, modelOrigin, onResult, onFrame, onError } = options;
  const trimmedOrigin = modelOrigin.replace(/\/$/, "");
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const [stream, setStream] = useState<MediaStream | null>(null);
  const [state, setState] = useState<ClassifierState>("idle");

  useEffect(() => {
    if (!cameraDeviceId) return;
    let cancelled = false;
    let acquiredStream: MediaStream | null = null;
    let classifier: MediaPipeOnnxClassifier | null = null;

    void (async () => {
      try {
        const fresh = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: cameraDeviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 },
          },
          audio: false,
        });
        if (cancelled) {
          for (const t of fresh.getTracks()) t.stop();
          return;
        }
        acquiredStream = fresh;
        setStream(fresh);

        classifier = new MediaPipeOnnxClassifier({
          stream: fresh,
          modelUrl: `${trimmedOrigin}/models/asl-signs/asl-signs.onnx`,
          labelsUrl: `${trimmedOrigin}/models/asl-signs/sign_to_prediction_index_map.json`,
          blockedLabels: BLOCKED_SIGN_LABELS,
          onFrame: (frame) => onFrameRef.current(frame),
        });
        classifier.onResult((result) => onResultRef.current(result));
        classifier.onStateChange((next, err) => {
          setState(next);
          if (err) {
            const message = err.message || "classifier error";
            log.warn("bridge-active", "classifier error", { message });
            onErrorRef.current(message);
          }
        });
        await classifier.start();
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        log.error("bridge-active", "classifier start failed", { message });
        onErrorRef.current(message);
      }
    })();

    return () => {
      cancelled = true;
      if (classifier) {
        void classifier.stop();
      }
      if (acquiredStream) {
        for (const t of acquiredStream.getTracks()) t.stop();
      }
      setStream(null);
      setState("stopped");
    };
    // trimmedOrigin is derived from modelOrigin; depending on cameraDeviceId
    // and modelOrigin is sufficient.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraDeviceId, modelOrigin]);

  return { stream, state };
}
