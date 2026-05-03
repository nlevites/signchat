import { create } from "zustand";
import type { ParticipantInfo, Role } from "@signchat/contracts";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface LiveKitCredentials {
  wsUrl: string;
  token: string;
  tokenExpiresAt: number;
}

interface RoomState {
  roomId: string | null;
  identity: string | null;
  name: string | null;
  role: Role | null;
  connectionState: ConnectionState;
  remoteParticipant: ParticipantInfo | null;
  wsUrl: string | null;
  token: string | null;
  tokenExpiresAt: number | null;
  setRoomId: (roomId: string | null) => void;
  setIdentity: (identity: string | null) => void;
  setName: (name: string | null) => void;
  setRole: (role: Role | null) => void;
  setConnectionState: (state: ConnectionState) => void;
  setRemoteParticipant: (p: ParticipantInfo | null) => void;
  setLiveKitCredentials: (creds: LiveKitCredentials) => void;
  clearLiveKitCredentials: () => void;
  reset: () => void;
}

const INITIAL = {
  roomId: null,
  identity: null,
  name: null,
  role: null,
  connectionState: "idle" as ConnectionState,
  remoteParticipant: null,
  wsUrl: null,
  token: null,
  tokenExpiresAt: null,
};

export const useRoomStore = create<RoomState>((set) => ({
  ...INITIAL,
  setRoomId: (roomId) => set({ roomId }),
  setIdentity: (identity) => set({ identity }),
  setName: (name) => set({ name }),
  setRole: (role) => set({ role }),
  setConnectionState: (connectionState) => set({ connectionState }),
  setRemoteParticipant: (remoteParticipant) => set({ remoteParticipant }),
  setLiveKitCredentials: ({ wsUrl, token, tokenExpiresAt }) =>
    set({ wsUrl, token, tokenExpiresAt }),
  clearLiveKitCredentials: () =>
    set({ wsUrl: null, token: null, tokenExpiresAt: null }),
  reset: () => set(INITIAL),
}));
