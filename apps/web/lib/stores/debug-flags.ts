import { create } from "zustand";

export interface DebugFlagsState {
  forceLLMError: boolean;
  forceTTSError: boolean;
  forceSessionBudget: boolean;
  setForceLLMError: (v: boolean) => void;
  setForceTTSError: (v: boolean) => void;
  setForceSessionBudget: (v: boolean) => void;
  reset: () => void;
}

export const useDebugFlagsStore = create<DebugFlagsState>((set) => ({
  forceLLMError: false,
  forceTTSError: false,
  forceSessionBudget: false,
  setForceLLMError: (forceLLMError) => set({ forceLLMError }),
  setForceTTSError: (forceTTSError) => set({ forceTTSError }),
  setForceSessionBudget: (forceSessionBudget) => set({ forceSessionBudget }),
  reset: () =>
    set({
      forceLLMError: false,
      forceTTSError: false,
      forceSessionBudget: false,
    }),
}));
