import { create } from "zustand";
import type { ClassifierResult } from "@/lib/sign-pipeline/classifier";
import type { VisionFrame } from "@/lib/sign-pipeline/mediapipe-runner";

export interface DebugSignalsState {
  cameraStream: MediaStream | null;
  latestFrame: VisionFrame | null;
  latestResult: ClassifierResult | null;
  setCameraStream: (s: MediaStream | null) => void;
  setLatestFrame: (f: VisionFrame | null) => void;
  setLatestResult: (r: ClassifierResult | null) => void;
  reset: () => void;
}

export const useDebugSignalsStore = create<DebugSignalsState>((set) => ({
  cameraStream: null,
  latestFrame: null,
  latestResult: null,
  setCameraStream: (cameraStream) => set({ cameraStream }),
  setLatestFrame: (latestFrame) => set({ latestFrame }),
  setLatestResult: (latestResult) => set({ latestResult }),
  reset: () =>
    set({ cameraStream: null, latestFrame: null, latestResult: null }),
}));
