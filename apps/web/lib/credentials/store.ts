import { create } from "zustand";

interface OpenRouterCreds {
  apiKey: string;
  modelId: string;
  limitCredits: number;
  keyHash: string;
  label: string;
  createdAt: string;
}

interface ElevenLabsCreds {
  signedUrl: string;
  voiceId: string;
  modelId: string;
  outputFormat: string;
  expiresAt: string | null;
}

interface CredentialsState {
  openrouter: OpenRouterCreds | null;
  elevenlabs: ElevenLabsCreds | null;
  setOpenRouter: (c: OpenRouterCreds | null) => void;
  setElevenLabs: (c: ElevenLabsCreds | null) => void;
  clear: () => void;
}

export const useCredentialsStore = create<CredentialsState>((set) => ({
  openrouter: null,
  elevenlabs: null,
  setOpenRouter: (openrouter) => set({ openrouter }),
  setElevenLabs: (elevenlabs) => set({ elevenlabs }),
  clear: () => set({ openrouter: null, elevenlabs: null }),
}));
