import { create } from "zustand";
import type { ElevenLabsVoiceSummary } from "@signchat/contracts";
import { listElevenLabsVoices } from "@/lib/livekit/list-elevenlabs-voices";

type Status = "idle" | "loading" | "ready" | "error";

export interface VoicesState {
  status: Status;
  voices: readonly ElevenLabsVoiceSummary[];
  defaultVoiceId: string | null;
  error: string | null;
  /**
   * Fetch the voices list once and reuse the result on subsequent calls.
   * Pass `force: true` to refetch (e.g. after an error or a user retry).
   */
  load: (opts?: { force?: boolean }) => Promise<void>;
}

export const useVoicesStore = create<VoicesState>((set, get) => ({
  status: "idle",
  voices: [],
  defaultVoiceId: null,
  error: null,
  load: async (opts) => {
    const { status } = get();
    if (!opts?.force && (status === "loading" || status === "ready")) return;
    set({ status: "loading", error: null });
    try {
      const res = await listElevenLabsVoices();
      set({
        status: "ready",
        voices: res.voices,
        defaultVoiceId: res.defaultVoiceId,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ status: "error", error: message });
    }
  },
}));
