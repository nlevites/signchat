import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AdmitThresholds } from "@signchat/sign-pipeline";
import type { ReconstructionModelId } from "@signchat/prompts";

export interface PreferenceThresholds extends AdmitThresholds {
  silenceMs: number;
  intervalMs: number;
  autoStartThreshold: number;
  autoStopThreshold: number;
}

interface LastDevices {
  audioInputId: string | null;
  videoInputId: string | null;
  audioOutputId: string | null;
}

interface PreferencesState {
  modelId: ReconstructionModelId;
  mode: "auto" | "manual";
  thresholds: PreferenceThresholds;
  lastDevices: LastDevices;
  /**
   * Deaf-only: ElevenLabs voice id used when minting TTS signed URLs.
   * `null` means "use the server default" (`ELEVENLABS_VOICE_ID`).
   */
  elevenlabsVoiceId: string | null;
  setModelId: (id: ReconstructionModelId) => void;
  setMode: (mode: "auto" | "manual") => void;
  setThresholds: (patch: Partial<PreferenceThresholds>) => void;
  setLastDevice: (kind: keyof LastDevices, id: string | null) => void;
  setElevenlabsVoiceId: (id: string | null) => void;
}

const DEFAULT_THRESHOLDS: PreferenceThresholds = {
  top1Threshold: 0.3,
  top2Threshold: 0.15,
  silenceMs: 500,
  intervalMs: 200,
  autoStartThreshold: 0.25,
  autoStopThreshold: 0.03,
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      modelId: "google/gemini-3-flash-preview",
      mode: "auto",
      thresholds: { ...DEFAULT_THRESHOLDS },
      lastDevices: {
        audioInputId: null,
        videoInputId: null,
        audioOutputId: null,
      },
      elevenlabsVoiceId: null,
      setModelId: (modelId) => set({ modelId }),
      setMode: (mode) => set({ mode }),
      setThresholds: (patch) =>
        set((state) => ({ thresholds: { ...state.thresholds, ...patch } })),
      setLastDevice: (kind, id) =>
        set((state) => ({
          lastDevices: { ...state.lastDevices, [kind]: id },
        })),
      setElevenlabsVoiceId: (elevenlabsVoiceId) => set({ elevenlabsVoiceId }),
    }),
    {
      name: "signchat:preferences",
      version: 7,
      // v1 → v2: backfill the new auto-mode thresholds with defaults so
      // returning users don't end up with undefined fields driving the
      // confidence-streak detection.
      // v2 → v3: drop the now-unused whisperModelId field (cloud STT
      // has no per-variant selector).
      // v3 → v4: introduce elevenlabsVoiceId; default to null so existing
      // users keep getting the server-side ELEVENLABS_VOICE_ID until they
      // pick a voice in the Lobby or in-call settings panel.
      // v4 → v5: bump default reconstruction model to openai/gpt-5.4-mini.
      // Anyone still on the old auto-assigned default
      // (google/gemini-3-flash-preview) gets migrated; explicit picks of
      // the other two enumerated models are preserved.
      // v5 → v6: retune auto-mode threshold defaults toward a more
      // responsive baseline (lower top-k, shorter silence/interval).
      // Force-migrate everyone — their previously tuned values are
      // discarded so dashboards reflect the new shipped baseline.
      // v6 → v7: move the web reconstruction default back to Gemini Flash,
      // matching Bridge. Existing users still on the previous auto-assigned
      // default are migrated; other explicit model choices are preserved.
      migrate: (persisted, version) => {
        if (!persisted || typeof persisted !== "object") {
          return persisted as PreferencesState;
        }
        let s = persisted as Partial<PreferencesState> & {
          whisperModelId?: unknown;
        };
        if (version < 2) {
          const t = (s.thresholds ?? {}) as Partial<PreferenceThresholds>;
          s = {
            ...s,
            thresholds: {
              top1Threshold: t.top1Threshold ?? DEFAULT_THRESHOLDS.top1Threshold,
              top2Threshold: t.top2Threshold ?? DEFAULT_THRESHOLDS.top2Threshold,
              silenceMs: t.silenceMs ?? DEFAULT_THRESHOLDS.silenceMs,
              intervalMs: t.intervalMs ?? DEFAULT_THRESHOLDS.intervalMs,
              autoStartThreshold:
                t.autoStartThreshold ?? DEFAULT_THRESHOLDS.autoStartThreshold,
              autoStopThreshold:
                t.autoStopThreshold ?? DEFAULT_THRESHOLDS.autoStopThreshold,
            },
          };
        }
        if (version < 3) {
          const { whisperModelId: _drop, ...rest } = s;
          s = rest;
        }
        if (version < 4) {
          s = { ...s, elevenlabsVoiceId: s.elevenlabsVoiceId ?? null };
        }
        if (version < 5) {
          if (s.modelId === "google/gemini-3-flash-preview") {
            s = { ...s, modelId: "openai/gpt-5.4-mini" };
          }
        }
        if (version < 6) {
          s = { ...s, thresholds: { ...DEFAULT_THRESHOLDS } };
        }
        if (version < 7) {
          if (s.modelId === "openai/gpt-5.4-mini") {
            s = { ...s, modelId: "google/gemini-3-flash-preview" };
          }
        }
        return s as PreferencesState;
      },
    },
  ),
);
