import type {
  PromptConfidence,
  PromptTestCase,
  ReconstructionPayload,
  ScoreBreakdown,
  SignToken,
} from "./types";

const WORD_RE = /[a-z0-9']+/g;
const CONFIDENCES: readonly PromptConfidence[] = ["high", "medium", "low"];

export interface ParseResult {
  valid: boolean;
  parsed: ReconstructionPayload | null;
  error: string | null;
}

export function parseReconstructionPayload(raw: string): ParseResult {
  const extracted = extractJsonObject(raw);
  if (!extracted) {
    return { valid: false, parsed: null, error: "No JSON object found in response" };
  }

  try {
    const value = JSON.parse(extracted) as unknown;
    if (!isReconstructionPayload(value)) {
      return { valid: false, parsed: null, error: "Response JSON does not match schema" };
    }
    return { valid: true, parsed: value, error: null };
  } catch (error) {
    return {
      valid: false,
      parsed: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Compute all scoring axes for a single model response.
 *
 * Composite weights — the LLM judge is the boss; everything else is a sanity tax:
 *   0.70 naturalness     — LLM judge on natural-and-on-topic English (dominant signal)
 *   0.10 sentenceExact   — locked-script ground-truth match (penalizes good natural variants, low weight on purpose)
 *   0.05 embeddingSim    — semantic similarity, 0 when remote unavailable
 *   0.05 rouge1Recall    — partial credit for token recall
 *   0.05 signUsageRate   — grounding: did the model actually use the ASL input?
 *   0.05 jsonValid       — schema compliance gate
 *
 * When naturalness is undefined (judge disabled or call failed), composite is
 * null — the caller and UI must surface this rather than silently scoring on
 * 0.3 of the axes. confidenceReported is a diagnostic only, not in composite.
 */
export function scoreResponse(
  parseResult: ParseResult,
  testCase: PromptTestCase,
  embeddingSimilarity = 0,
  naturalness?: number,
): ScoreBreakdown {
  const acceptable = testCase.expected.acceptableSentences ?? [];
  const jsonValid = parseResult.valid ? 1 : 0;

  const sentenceExactScore = parseResult.parsed
    ? sentenceExact(parseResult.parsed.sentence, testCase.expected.sentence, acceptable)
    : 0;

  const rouge1Score = parseResult.parsed
    ? rouge1Recall(parseResult.parsed.sentence, testCase.expected.sentence, acceptable)
    : 0;

  const clampedEmbedding = Math.max(0, Math.min(1, embeddingSimilarity));

  const signUsage = parseResult.parsed
    ? signUsageRate(parseResult.parsed.usedSigns, testCase.recognizedSigns)
    : 0;

  const confidenceScore = parseResult.parsed
    ? confidenceToNumber(parseResult.parsed.confidence)
    : 0;

  const composite =
    naturalness === undefined
      ? null
      : round(
          0.70 * Math.max(0, Math.min(1, naturalness)) +
          0.10 * sentenceExactScore +
          0.05 * clampedEmbedding +
          0.05 * rouge1Score +
          0.05 * signUsage +
          0.05 * jsonValid,
        );

  return {
    jsonValid,
    sentenceExact: sentenceExactScore,
    rouge1Recall: round(rouge1Score),
    embeddingSimilarity: round(clampedEmbedding),
    signUsageRate: round(signUsage),
    confidenceReported: confidenceScore,
    composite,
  };
}

export function computeCostUsd(
  usage: { inputTokens?: number; outputTokens?: number } | undefined,
  pricing: { prompt: string | null; completion: string | null } | null | undefined,
): number | undefined {
  if (!usage || !pricing) return undefined;
  const promptPrice = pricing.prompt ? Number(pricing.prompt) : NaN;
  const completionPrice = pricing.completion ? Number(pricing.completion) : NaN;
  if (!Number.isFinite(promptPrice) && !Number.isFinite(completionPrice)) return undefined;
  const promptCost = Number.isFinite(promptPrice) ? (usage.inputTokens ?? 0) * promptPrice : 0;
  const completionCost = Number.isFinite(completionPrice)
    ? (usage.outputTokens ?? 0) * completionPrice
    : 0;
  return Math.round((promptCost + completionCost) * 1_000_000) / 1_000_000;
}

function isReconstructionPayload(value: unknown): value is ReconstructionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ReconstructionPayload>;
  return (
    typeof candidate.sentence === "string" &&
    typeof candidate.confidence === "string" &&
    CONFIDENCES.includes(candidate.confidence as PromptConfidence) &&
    (typeof candidate.matchedScriptId === "string" || candidate.matchedScriptId === null) &&
    Array.isArray(candidate.usedSigns) &&
    candidate.usedSigns.every((sign) => typeof sign === "string")
  );
}

function extractJsonObject(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  return trimmed.slice(first, last + 1);
}

function sentenceExact(actual: string, expected: string, acceptable: readonly string[]): number {
  const normalizedActual = normalizeSentence(actual);
  const normalizedExpected = [expected, ...acceptable].map(normalizeSentence);
  return normalizedExpected.includes(normalizedActual) ? 1 : 0;
}

/**
 * ROUGE-1 recall: fraction of expected word tokens that appear anywhere in actual.
 * Best of actual vs expected and all acceptable variants.
 */
function rouge1Recall(actual: string, expected: string, acceptable: readonly string[]): number {
  return Math.max(
    computeRouge1(tokenizeSentence(actual), tokenizeSentence(expected)),
    ...acceptable.map((s) => computeRouge1(tokenizeSentence(actual), tokenizeSentence(s))),
  );
}

function computeRouge1(actual: readonly string[], reference: readonly string[]): number {
  if (reference.length === 0) return 1;
  const actualSet = new Set(actual);
  const hits = reference.filter((w) => actualSet.has(w)).length;
  return hits / reference.length;
}

/**
 * Fraction of recognized classifier tokens that the model claimed to have used.
 * Handles the display label mismatch (e.g. "WEUS" → "we/us") by comparing
 * both raw uppercase and the lowercased display form.
 */
function signUsageRate(usedSigns: readonly string[], recognizedSigns: readonly SignToken[]): number {
  if (recognizedSigns.length === 0) return 1;
  const usedSet = new Set(usedSigns.map((s) => s.toUpperCase()));
  const hits = recognizedSigns.filter((sign) => usedSet.has(sign.word.toUpperCase())).length;
  return hits / recognizedSigns.length;
}

function confidenceToNumber(c: PromptConfidence): number {
  if (c === "high") return 1;
  if (c === "medium") return 0.5;
  return 0;
}

function normalizeSentence(sentence: string): string {
  return tokenizeSentence(sentence).join(" ");
}

function tokenizeSentence(sentence: string): readonly string[] {
  return sentence.toLowerCase().match(WORD_RE) ?? [];
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
