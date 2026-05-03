import { create } from "zustand";
import type { ParticipantInfo, RoomDataMessage } from "@signchat/contracts";

interface PartialEntry {
  from: ParticipantInfo;
  text: string;
  ts: number;
}

interface TranscriptState {
  messages: RoomDataMessage[];
  partialsByUtterance: Record<string, PartialEntry>;
  /**
   * True when the Deaf-side STT streaming loop has detected sustained
   * partial latency above the §5.8 1.5 s threshold. UI surfaces this as a
   * `captions: degraded` chip on the Hearing tile. Currently always
   * false with cloud STT; left in place for future server-side latency
   * telemetry derived from `stt.first-partial`.
   */
  captionsDegraded: boolean;
  appendMessage: (msg: RoomDataMessage) => void;
  upsertPartial: (id: string, entry: PartialEntry) => void;
  finalizePartial: (id: string) => void;
  setCaptionsDegraded: (v: boolean) => void;
  clear: () => void;
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  messages: [],
  partialsByUtterance: {},
  captionsDegraded: false,
  appendMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),
  upsertPartial: (id, entry) =>
    set((state) => ({
      partialsByUtterance: { ...state.partialsByUtterance, [id]: entry },
    })),
  finalizePartial: (id) =>
    set((state) => {
      if (!(id in state.partialsByUtterance)) return state;
      const { [id]: _drop, ...rest } = state.partialsByUtterance;
      return { partialsByUtterance: rest };
    }),
  setCaptionsDegraded: (captionsDegraded) => set({ captionsDegraded }),
  clear: () =>
    set({
      messages: [],
      partialsByUtterance: {},
      captionsDegraded: false,
    }),
}));
