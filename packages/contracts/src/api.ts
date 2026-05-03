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
  modelId: "openai/gpt-5.4-mini";
  createdAt: string;
}

export interface CreateElevenLabsSignedUrlRequest {
  roomId: string;
  identity: string;
  role: "deaf";
  /** Optional override; server falls back to `ELEVENLABS_VOICE_ID`. */
  voiceId?: string;
  modelId?: "eleven_flash_v2_5";
  outputFormat?: "pcm_24000";
}

export interface ElevenLabsVoiceSummary {
  voiceId: string;
  name: string;
  /** ElevenLabs category (e.g. "premade", "cloned", "generated", "professional"). */
  category: string;
  description?: string;
  /** mp3 sample served by ElevenLabs CDN. */
  previewUrl?: string;
  labels?: {
    gender?: string;
    accent?: string;
    age?: string;
    descriptive?: string;
  };
}

export interface ListElevenLabsVoicesResponse {
  voices: ElevenLabsVoiceSummary[];
  /** The voice id minted when no override is supplied (`ELEVENLABS_VOICE_ID`). */
  defaultVoiceId: string;
}

export interface CreateElevenLabsSignedUrlResponse {
  signedUrl: string;
  voiceId: string;
  modelId: "eleven_flash_v2_5";
  outputFormat: "pcm_24000";
  expiresAt: string | null;
}

export interface CreateElevenLabsSttSignedUrlRequest {
  roomId: string;
  identity: string;
  role: "deaf";
}

export interface CreateElevenLabsSttSignedUrlResponse {
  signedUrl: string;
  modelId: "scribe_v2_realtime";
  audioFormat: "pcm_16000";
  expiresAt: string;
}

export interface HealthResponse {
  ok: true;
  region: "pdx1";
  commit: string;
}

export interface ApiError {
  error: string;
}
