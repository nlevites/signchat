import { create } from "zustand";
import type { ReconstructionPayload } from "@signchat/contracts";
import type { ReconstructionModelId } from "@signchat/prompts";
import type { ClassifierResult } from "@/lib/sign-pipeline/classifier";
import type { VisionFrame } from "@/lib/sign-pipeline/mediapipe-runner";

/** Lifecycle of the most-recent OpenRouter reconstruct call. */
export type ReconstructPromptStatus = "pending" | "ok" | "error";

export interface ReconstructPromptSnapshot {
  /** Monotonically incremented per call; lets the UI animate transitions. */
  seq: number;
  status: ReconstructPromptStatus;
  modelId: ReconstructionModelId;
  systemPrompt: string;
  userPrompt: string;
  /** Comma-joined tokens fed into the user prompt this turn (for quick scanning). */
  signs: string[];
  /** `Date.now()` at request send. */
  sentAt: number;
  /** Set on `ok` / `error`; ms from send to settle. */
  latencyMs?: number;
  /** Set on `ok`. */
  parsed?: ReconstructionPayload;
  /** Raw `choices[0].message.content` JSON string. */
  raw?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  /** Set on `error`. */
  errorMessage?: string;
}

export interface DebugSignalsState {
  cameraStream: MediaStream | null;
  latestFrame: VisionFrame | null;
  latestResult: ClassifierResult | null;
  lastReconstructPrompt: ReconstructPromptSnapshot | null;
  setCameraStream: (s: MediaStream | null) => void;
  setLatestFrame: (f: VisionFrame | null) => void;
  setLatestResult: (r: ClassifierResult | null) => void;
  /** Replace the in-flight prompt snapshot (status: "pending"). */
  setReconstructPromptPending: (
    snap: Omit<
      ReconstructPromptSnapshot,
      | "seq"
      | "status"
      | "latencyMs"
      | "parsed"
      | "raw"
      | "inputTokens"
      | "outputTokens"
      | "costUsd"
      | "errorMessage"
    >,
  ) => void;
  /** Patch the most-recent snapshot with completion/error data. */
  patchReconstructPrompt: (
    patch: Partial<
      Pick<
        ReconstructPromptSnapshot,
        | "status"
        | "latencyMs"
        | "parsed"
        | "raw"
        | "inputTokens"
        | "outputTokens"
        | "costUsd"
        | "errorMessage"
      >
    >,
  ) => void;
  reset: () => void;
}

export const useDebugSignalsStore = create<DebugSignalsState>((set) => ({
  cameraStream: null,
  latestFrame: null,
  latestResult: null,
  lastReconstructPrompt: null,
  setCameraStream: (cameraStream) => set({ cameraStream }),
  setLatestFrame: (latestFrame) => set({ latestFrame }),
  setLatestResult: (latestResult) => set({ latestResult }),
  setReconstructPromptPending: (snap) =>
    set((state) => ({
      lastReconstructPrompt: {
        ...snap,
        seq: (state.lastReconstructPrompt?.seq ?? 0) + 1,
        status: "pending",
      },
    })),
  patchReconstructPrompt: (patch) =>
    set((state) => {
      const cur = state.lastReconstructPrompt;
      if (!cur) return state;
      return { lastReconstructPrompt: { ...cur, ...patch } };
    }),
  reset: () =>
    set({
      cameraStream: null,
      latestFrame: null,
      latestResult: null,
      lastReconstructPrompt: null,
    }),
}));
