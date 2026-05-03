import type { Role } from "./roles";

export interface ParticipantInfo {
  identity: string;
  name: string;
  role: Role;
}
