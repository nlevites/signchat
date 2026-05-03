import type { Role } from "./roles";

export interface LiveKitTokenQuery {
  room: string;
  identity: string;
  name?: string;
  role: Role;
}

export interface LiveKitTokenResponse {
  token: string;
  wsUrl: string;
  roomId: string;
  identity: string;
  name: string;
  role: Role;
}

export interface CreateOpenRouterSessionKeyRequest {
  roomId: string;
  identity: string;
  role: "deaf";
}

export interface CreateOpenRouterSessionKeyResponse {
  apiKey: string;
  keyHash: string;
  label: string;
  limitCredits: number;
  modelId: "google/gemini-3-flash-preview";
  createdAt: string;
}

export interface CreateElevenLabsSignedUrlRequest {
  roomId: string;
  identity: string;
  role: "deaf";
  voiceId: string;
  modelId?: "eleven_flash_v2_5";
  outputFormat?: "pcm_24000";
}

export interface CreateElevenLabsSignedUrlResponse {
  signedUrl: string;
  voiceId: string;
  modelId: "eleven_flash_v2_5";
  outputFormat: "pcm_24000";
  expiresAt: string | null;
}

export interface HealthResponse {
  ok: true;
  region: "pdx1";
  commit: string;
}

export interface ApiError {
  error: string;
}
