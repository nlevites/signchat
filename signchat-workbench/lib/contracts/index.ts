/**
 * Single source of truth for shared types across the workbench.
 *
 * Direct port of ARCHITECTURE.md §11.3 (sign-pipeline contracts) and §11.4
 * (LiveKit DataChannel messages). When the production app/web/ goes online
 * it will copy this file unchanged.
 */

export type Role = "deaf" | "hearing";

export interface ParticipantInfo {
  identity: string;
  name: string;
  role: Role;
}

// === Sign pipeline (§11.3) ===================================================

export interface SignToken {
  /** PopSign label, e.g. "PIZZA". */
  label: string;
  /** Softmax probability. */
  score: number;
  /** performance.now() at admit. */
  ts: number;
  via: "stable" | "band";
}

export interface SignBuffer {
  tokens: SignToken[];
  startedAt: number;
  lastAdmitAt: number | null;
  /** Bumped on Cancel/Discard so stale inflight inferences are dropped. */
  epoch: number;
}

// === LLM reconstruction payload (§11.1) ======================================

export type ReconstructionConfidence = "high" | "medium" | "low";

export interface ReconstructionPayload {
  sentence: string;
  confidence: ReconstructionConfidence;
  matchedScriptId: string | null;
  usedSigns: string[];
  /**
   * Optional hint from the model that the signer's intent was ambiguous and
   * a follow-up clarification turn is appropriate. Per ARCHITECTURE.md §11.1.
   * Optional so the existing CaptionMessage payload (Phase 2 DataChannel
   * round-trip) doesn't have to fabricate a value.
   */
  needsClarification?: boolean;
}

// === LiveKit DataChannel messages (§11.4) ====================================

export type RoomDataMessageVersion = 1;

export interface ChatMessage {
  v: RoomDataMessageVersion;
  kind: "chat";
  id: string;
  ts: number;
  from: ParticipantInfo;
  text: string;
}

export interface CaptionMessage {
  v: RoomDataMessageVersion;
  kind: "caption";
  /** Turn id; unique per Approved sentence. */
  id: string;
  /** Wall-clock ms at publish. */
  ts: number;
  /** AudioContext-aligned first-audible-sample time, in ms since epoch. */
  playAtMs: number;
  /** Always the Deaf signer. */
  from: ParticipantInfo;
  sentence: string;
  confidence: ReconstructionConfidence;
  usedSigns: string[];
  modelId: string;
  latencyMs: number;
}

export interface TranscriptPartialMessage {
  v: RoomDataMessageVersion;
  kind: "transcript_partial";
  /** Utterance id; partials and final share it. */
  id: string;
  ts: number;
  /** The Hearing speaker (originally), republished by the Deaf side. */
  from: ParticipantInfo;
  text: string;
}

export interface TranscriptFinalMessage {
  v: RoomDataMessageVersion;
  kind: "transcript_final";
  id: string;
  ts: number;
  from: ParticipantInfo;
  text: string;
}

export type RoomDataMessage =
  | ChatMessage
  | CaptionMessage
  | TranscriptPartialMessage
  | TranscriptFinalMessage;

export type RoomDataMessageKind = RoomDataMessage["kind"];

/**
 * Reliability per kind (§6.3). Encoded as a const map so the publish helper
 * (lib/livekit/data-channel.ts) reads from the contract instead of inlining
 * booleans at every call site.
 */
export const RELIABILITY_BY_KIND: Record<RoomDataMessageKind, boolean> = {
  chat: true,
  caption: true,
  transcript_partial: false,
  transcript_final: true,
};

// === Mode controller (§9.1) ==================================================

export type ModeState =
  | "idle"
  | "capturing"
  | "stitching"
  | "preview"
  | "speaking";

export type CaptureMode = "auto" | "manual";

export interface AutoThresholds {
  top1Threshold: number;
  top2Threshold: number;
  silenceMs: number;
  inferenceIntervalMs: number;
}

export const DEFAULT_AUTO_THRESHOLDS: AutoThresholds = {
  top1Threshold: 0.5,
  top2Threshold: 0.3,
  silenceMs: 2000,
  inferenceIntervalMs: 500,
};

/** Fixed invariant of the admit logic, not a slider (§5.5). */
export const STABILITY_TICKS = 2;

// === Credential-mint route DTOs (§10) ========================================
// Server returns these to the browser. Never include raw provider secrets in
// any field other than the explicitly-bounded ones documented here.

export interface MintLiveKitTokenRequest {
  room: string;
  identity: string;
  name?: string;
  role: Role;
}

export interface MintLiveKitTokenResponse {
  token: string;
  wsUrl: string;
  roomId: string;
  identity: string;
  name: string;
  role: Role;
}

export interface MintOpenRouterSessionKeyRequest {
  roomId: string;
  identity: string;
  /** Only Deaf signers mint OpenRouter session keys (§10.2). */
  role: "deaf";
}

export interface MintOpenRouterSessionKeyResponse {
  /** Single-use return; never logged server-side. Bounded by limitCredits. */
  apiKey: string;
  keyHash: string;
  /** signchat:<roomId>:<identity>:<timestamp> */
  label: string;
  limitCredits: number;
  modelId: string;
  createdAt: string;
}

export interface MintElevenLabsSignedUrlRequest {
  roomId: string;
  identity: string;
  /** Only Deaf signers mint ElevenLabs signed URLs (§10.3). */
  role: "deaf";
  voiceId?: string;
  modelId?: "eleven_flash_v2_5";
  outputFormat?: "pcm_24000";
}

export interface MintElevenLabsSignedUrlResponse {
  signedUrl: string;
  voiceId: string;
  modelId: "eleven_flash_v2_5";
  outputFormat: "pcm_24000";
  expiresAt: string | null;
}

export interface MintErrorResponse {
  error: string;
}
