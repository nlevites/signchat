import { create } from "zustand";
import type { SignBuffer } from "@signchat/contracts";
import {
  admitToken as admitTokenFn,
  type Candidate,
} from "@signchat/sign-pipeline";

export type Mode = "auto" | "manual";

export interface ModeThresholds {
  top1Threshold: number;
  top2Threshold: number;
  silenceMs: number;
  intervalMs: number;
}

interface ModeState {
  mode: Mode;
  buffer: SignBuffer;
  awaitingPreview: boolean;
  prevTopLabel: string | null;
  silenceTimerHandle: ReturnType<typeof setTimeout> | null;
  thresholds: ModeThresholds;
  setMode: (mode: Mode) => void;
  setThresholds: (patch: Partial<ModeThresholds>) => void;
  admitToken: (top1: Candidate, top2: Candidate) => void;
  clearBuffer: () => void;
  bumpEpoch: () => void;
  setAwaitingPreview: (v: boolean) => void;
}

const DEFAULT_THRESHOLDS: ModeThresholds = {
  top1Threshold: 0.5,
  top2Threshold: 0.3,
  silenceMs: 2000,
  intervalMs: 500,
};

function emptyBuffer(): SignBuffer {
  return { tokens: [], startedAt: 0, lastAdmitAt: null, epoch: 0 };
}

export const useModeStore = create<ModeState>((set, get) => ({
  mode: "auto",
  buffer: emptyBuffer(),
  awaitingPreview: false,
  prevTopLabel: null,
  silenceTimerHandle: null,
  thresholds: DEFAULT_THRESHOLDS,
  setMode: (mode) => set({ mode }),
  setThresholds: (patch) =>
    set((state) => ({ thresholds: { ...state.thresholds, ...patch } })),
  admitToken: (top1, top2) => {
    const { buffer, prevTopLabel, thresholds } = get();
    const startedAt =
      buffer.tokens.length === 0 ? performance.now() : buffer.startedAt;
    const seeded: SignBuffer = { ...buffer, startedAt };
    const next = admitTokenFn(seeded, top1, top2, thresholds, prevTopLabel);
    set({ buffer: next, prevTopLabel: top1.label });
  },
  clearBuffer: () =>
    set({
      buffer: emptyBuffer(),
      prevTopLabel: null,
      awaitingPreview: false,
    }),
  bumpEpoch: () =>
    set((state) => ({
      buffer: { ...state.buffer, epoch: state.buffer.epoch + 1 },
    })),
  setAwaitingPreview: (awaitingPreview) => set({ awaitingPreview }),
}));
