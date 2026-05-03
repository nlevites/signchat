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
  appendMessage: (msg: RoomDataMessage) => void;
  upsertPartial: (id: string, entry: PartialEntry) => void;
  finalizePartial: (id: string) => void;
  clear: () => void;
}

export const useTranscriptStore = create<TranscriptState>((set) => ({
  messages: [],
  partialsByUtterance: {},
  appendMessage: (msg) =>
    set((state) => ({ messages: [...state.messages, msg] })),
  upsertPartial: (id, entry) =>
    set((state) => ({
      partialsByUtterance: { ...state.partialsByUtterance, [id]: entry },
    })),
  finalizePartial: (id) =>
    set((state) => {
      const partial = state.partialsByUtterance[id];
      if (!partial) return state;
      const { [id]: _drop, ...rest } = state.partialsByUtterance;
      const finalMsg: RoomDataMessage = {
        v: 1,
        kind: "transcript_final",
        id,
        ts: partial.ts,
        from: partial.from,
        text: partial.text,
      };
      return {
        messages: [...state.messages, finalMsg],
        partialsByUtterance: rest,
      };
    }),
  clear: () => set({ messages: [], partialsByUtterance: {} }),
}));
