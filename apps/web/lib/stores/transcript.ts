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
   * True when the Deaf-side Whisper streaming loop has detected sustained
   * partial-inference latency above ARCHITECTURE.md §5.8's 1.5 s threshold
   * (rolling p50 over the last 3 utterances). UI surfaces this as a
   * `captions: degraded` chip on the Hearing tile.
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
