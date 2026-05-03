import { create } from "zustand";
import type { ParticipantInfo, Role } from "@signchat/contracts";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

interface RoomState {
  roomId: string | null;
  identity: string | null;
  name: string | null;
  role: Role | null;
  connectionState: ConnectionState;
  remoteParticipant: ParticipantInfo | null;
  setRoomId: (roomId: string | null) => void;
  setIdentity: (identity: string | null) => void;
  setName: (name: string | null) => void;
  setRole: (role: Role | null) => void;
  setConnectionState: (state: ConnectionState) => void;
  setRemoteParticipant: (p: ParticipantInfo | null) => void;
  reset: () => void;
}

const INITIAL = {
  roomId: null,
  identity: null,
  name: null,
  role: null,
  connectionState: "idle" as ConnectionState,
  remoteParticipant: null,
};

export const useRoomStore = create<RoomState>((set) => ({
  ...INITIAL,
  setRoomId: (roomId) => set({ roomId }),
  setIdentity: (identity) => set({ identity }),
  setName: (name) => set({ name }),
  setRole: (role) => set({ role }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setRemoteParticipant: (remoteParticipant) => set({ remoteParticipant }),
  reset: () => set(INITIAL),
}));
