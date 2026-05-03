export type ModeState =
  | "idle"
  | "capturing"
  | "stitching"
  | "preview"
  | "speaking";

export type CaptureMode = "auto" | "manual";

export interface AutoThresholds {
  top1Threshold: number;
  top2Threshold: number;
  silenceMs: number;
  inferenceIntervalMs: number;
  /** Auto mode: top1 score that auto-triggers idle → capturing on a single tick. */
  autoStartThreshold: number;
  /** Auto mode: top1 score below which the silence streak accumulates. */
  autoStopThreshold: number;
}

export const DEFAULT_AUTO_THRESHOLDS: AutoThresholds = {
  top1Threshold: 0.3,
  top2Threshold: 0.1,
  silenceMs: 500,
  inferenceIntervalMs: 200,
  autoStartThreshold: 0.25,
  autoStopThreshold: 0.03,
};
