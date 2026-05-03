export type PromptConfidence = "high" | "medium" | "low";

export const SCRIPT_TOPICS = [
  "greeting",
  "family",
  "feelings",
  "body",
  "home",
  "food-drink",
  "clothing-color",
  "weather-outside",
  "animals",
  "daily-routine",
  "goodbye",
] as const;
export type ScriptTopic = (typeof SCRIPT_TOPICS)[number];

export interface SignToken {
  word: string;
  confidence: number;
}

export interface SignTokenAlternative {
  word: string;
  score: number;
}

export interface SignTokenTopK {
  word: string;
  score: number;
  alternatives: readonly SignTokenAlternative[];
}

export interface ConversationTurn {
  hearing: string;
  signer: string;
}

export interface ReconstructionPayload {
  sentence: string;
  confidence: PromptConfidence;
  matchedScriptId: string | null;
  usedSigns: string[];
}

export interface ScriptTurn {
  id: string;
  topic: ScriptTopic;
  hearingUserSays: string;
  signerTokens: readonly string[];
  reconstructedSentence: string;
}

export interface ComboEntry {
  turnId: string;
  contextHints: readonly string[];
  must: readonly string[];
  optional: readonly string[];
  say: string;
}

export interface ExpectedResult {
  sentence: string;
  matchedScriptId: string | null;
  acceptableSentences?: readonly string[];
}

export interface PromptTestCase {
  id: string;
  suite: string;
  topic: ScriptTopic;
  baseTurnId: string;
  hearingTranscript: readonly string[];
  recognizedSigns: readonly SignToken[];
  signTokensTopK?: readonly SignTokenTopK[];
  conversationHistory?: readonly ConversationTurn[];
  expected: ExpectedResult;
  notes?: string;
}

export interface PriceInfo {
  prompt: string | null;
  completion: string | null;
}

export interface PromptTesterRunRequest {
  modelId: string;
  systemPrompt: string;
  userPromptTemplate: string;
  caseId: string;
  strategyId?: string | null;
  pricing?: PriceInfo | null;
}

export interface PromptTesterCompareRequest {
  modelId: string;
  caseId: string;
  strategyIds: readonly string[];
  pricing?: PriceInfo | null;
  systemPromptOverride?: string | null;
  userPromptTemplateOverride?: string | null;
}

export interface ScoreBreakdown {
  jsonValid: number;           // 1 = parses + schema-valid, 0 = not
  sentenceExact: number;       // 1 = normalized exact match, 0 = not
  rouge1Recall: number;        // 0–1: fraction of expected tokens present in actual
  embeddingSimilarity: number; // 0–1: remote cosine similarity, or 0 if unavailable
  signUsageRate: number;       // 0–1: fraction of recognized signs present in usedSigns
  confidenceReported: number;  // diagnostic: "high"→1.0, "medium"→0.5, "low"→0.0
  composite: number | null;    // null when judge unavailable; weights: 0.70 nat + 0.10 exact + 0.05 emb + 0.05 rouge + 0.05 sign + 0.05 jsonValid
}

export interface PromptTesterRunResponse {
  modelId: string;
  caseId: string;
  strategyId: string | null;
  prompt: {
    system: string;
    user: string;
  };
  rawResponse: string;
  parsed: ReconstructionPayload | null;
  parseError: string | null;
  score: ScoreBreakdown;
  latencyMs: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
  naturalness?: number;
  expected: ExpectedResult;
}

export interface PromptTesterCompareResponse {
  caseId: string;
  modelId: string;
  results: readonly PromptTesterRunResponse[];
}

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number | null;
  promptPrice: string | null;
  completionPrice: string | null;
}
