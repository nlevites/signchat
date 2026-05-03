import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AdmitThresholds } from "@signchat/sign-pipeline";
import type { ReconstructionModelId } from "@signchat/prompts";

export type WhisperModelId =
  | "Xenova/whisper-tiny.en"
  | "Xenova/whisper-base.en"
  | "Xenova/whisper-small.en";

export interface PreferenceThresholds extends AdmitThresholds {
  silenceMs: number;
  intervalMs: number;
}

interface LastDevices {
  audioInputId: string | null;
  videoInputId: string | null;
  audioOutputId: string | null;
}

interface PreferencesState {
  modelId: ReconstructionModelId;
  whisperModelId: WhisperModelId;
  mode: "auto" | "manual";
  thresholds: PreferenceThresholds;
  lastDevices: LastDevices;
  setModelId: (id: ReconstructionModelId) => void;
  setWhisperModelId: (id: WhisperModelId) => void;
  setMode: (mode: "auto" | "manual") => void;
  setThresholds: (patch: Partial<PreferenceThresholds>) => void;
  setLastDevice: (kind: keyof LastDevices, id: string | null) => void;
}

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      modelId: "google/gemini-3-flash-preview",
      whisperModelId: "Xenova/whisper-base.en",
      mode: "auto",
      thresholds: {
        top1Threshold: 0.5,
        top2Threshold: 0.3,
        silenceMs: 2000,
        intervalMs: 500,
      },
      lastDevices: {
        audioInputId: null,
        videoInputId: null,
        audioOutputId: null,
      },
      setModelId: (modelId) => set({ modelId }),
      setWhisperModelId: (whisperModelId) => set({ whisperModelId }),
      setMode: (mode) => set({ mode }),
      setThresholds: (patch) =>
        set((state) => ({ thresholds: { ...state.thresholds, ...patch } })),
      setLastDevice: (kind, id) =>
        set((state) => ({
          lastDevices: { ...state.lastDevices, [kind]: id },
        })),
    }),
    { name: "signchat:preferences" },
  ),
);
