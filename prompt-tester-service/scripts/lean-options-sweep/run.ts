// Lean-options full model sweep runner.
//
// Runs every case in ALL_CASES against every configured model using the
// `lean-options` strategy. Writes per-case raw JSON to disk as it goes so
// the run is resumable, then hands off to summarize.ts to emit the
// chart-ready aggregates.
//
// Usage (from prompt-tester-service/):
//   npx tsx scripts/lean-options-sweep/run.ts [--smoke] [--force] [--no-judge] [--no-embeddings]

import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_CASES } from "../../lib/fixtures";
import { getStrategy } from "../../lib/strategies";
import { composeUserPrompt } from "../../lib/compose";
import {
  computeCostUsd,
  parseReconstructionPayload,
  scoreResponse,
} from "../../lib/scoring";
import type {
  PriceInfo,
  PromptTestCase,
  ReconstructionPayload,
  ScoreBreakdown,
} from "../../lib/types";

import { summarizeRun } from "./summarize";

// ── Config ────────────────────────────────────────────────────────────────

const MODEL_IDS: readonly string[] = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-nano",
  "~anthropic/claude-haiku-latest",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "meta-llama/llama-4-maverick",
  "mistralai/mistral-small-2603",
  "cohere/command-a",
];

const STRATEGY_ID = "lean-options";
const MODEL_CONCURRENCY = 5;
const JUDGE_CONCURRENCY = 3;
const MODEL_TIMEOUT_MS = 10_000; // generous per-request cap for sweep; 2s latency cutoff is measured, not enforced
const PRIMARY_RETRY_ATTEMPTS = 1;

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.4-mini";
const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-large";

const NATURALNESS_RUBRIC = `You score how natural and contextually appropriate a reconstructed sentence is given a conversation context.

Rubric (1 to 5):
1 = unnatural, nonsensical, or off-topic
2 = stilted or awkward English
3 = OK but flat
4 = natural and on-topic
5 = natural, on-topic, and matches the hearing user's tone (echoing words like "usually" from their question is a positive signal)

Reply with strict JSON only: {"score": <integer 1-5>}.`;

// ── CLI flag parsing ──────────────────────────────────────────────────────

const ARGS = new Set(process.argv.slice(2));
const IS_SMOKE = ARGS.has("--smoke");
const FORCE = ARGS.has("--force");
const JUDGE_ENABLED = !ARGS.has("--no-judge");
const EMBEDDINGS_ENABLED = !ARGS.has("--no-embeddings");
const RUN_ID_OVERRIDE = (() => {
  const flag = process.argv.find((arg) => arg.startsWith("--run-id="));
  return flag ? flag.slice("--run-id=".length) : null;
})();

// ── Env loading ───────────────────────────────────────────────────────────

function loadEnv(scriptDir: string): Record<string, string> {
  try {
    const raw = readFileSync(join(scriptDir, "..", "..", ".env"), "utf8");
    const env: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FILE_ENV = loadEnv(SCRIPT_DIR);
const API_KEY = process.env.OPENROUTER_API_KEY || FILE_ENV.OPENROUTER_API_KEY;
const APP_URL =
  process.env.OPENROUTER_APP_URL || FILE_ENV.OPENROUTER_APP_URL || "http://localhost:3010";
const APP_NAME =
  process.env.OPENROUTER_APP_NAME || FILE_ENV.OPENROUTER_APP_NAME || "SignChat Prompt Tester Sweep";

if (!API_KEY) {
  console.error("Missing OPENROUTER_API_KEY in env or .env");
  process.exit(1);
}

const JUDGE_MODEL =
  process.env.OPENROUTER_JUDGE_MODEL || FILE_ENV.OPENROUTER_JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
const EMBEDDING_MODEL =
  process.env.OPENROUTER_EMBEDDING_MODEL ||
  FILE_ENV.OPENROUTER_EMBEDDING_MODEL ||
  DEFAULT_EMBEDDING_MODEL;

// ── Types ─────────────────────────────────────────────────────────────────

interface RawResultRecord {
  runId: string;
  createdAt: string;
  modelId: string;
  strategyId: string;
  suite: string;
  caseId: string;
  baseTurnId: string;
  topic: string;
  judgeEnabled: boolean;
  embeddingsEnabled: boolean;
  input: {
    hearingTranscript: readonly string[];
    recognizedSigns: PromptTestCase["recognizedSigns"];
    signTokensTopK: PromptTestCase["signTokensTopK"];
    expected: PromptTestCase["expected"];
    notes: PromptTestCase["notes"];
  };
  prompt: {
    system: string;
    user: string;
  };
  response: {
    rawContent: string;
    parsed: ReconstructionPayload | null;
    parseError: string | null;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
    };
    costUsd?: number;
  };
  score: ScoreBreakdown;
  naturalness?: number;
  embeddingSimilarity: number;
  latencyMs: number;
  totalElapsedMs: number;
  status: "ok" | "timeout" | "http_error" | "empty" | "network_error";
  error?: string;
  retries: number;
  providerPricing?: PriceInfo | null;
}

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

interface ProgressState {
  total: number;
  completed: number;
  skipped: number;
  failed: number;
  startedAt: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────

function sanitizeSegment(value: string): string {
  return value.replace(/[~\/\\\s]/g, (match) => (match === "/" ? "/" : "_"));
}

function modelDirSegment(modelId: string): string {
  return modelId.replace(/~/g, "").replace(/\//g, "__");
}

function rawResultPath(runDir: string, modelId: string, testCase: PromptTestCase): string {
  const modelSeg = modelDirSegment(modelId);
  const suiteSeg = sanitizeSegment(testCase.suite);
  const caseSeg = sanitizeSegment(testCase.baseTurnId);
  return join(runDir, "raw", modelSeg, suiteSeg, `${caseSeg}.json`);
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function currentRunId(): string {
  if (RUN_ID_OVERRIDE) return RUN_ID_OVERRIDE;
  const now = new Date();
  const stamp =
    now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, "0") +
    String(now.getUTCDate()).padStart(2, "0") +
    "-" +
    String(now.getUTCHours()).padStart(2, "0") +
    String(now.getUTCMinutes()).padStart(2, "0") +
    String(now.getUTCSeconds()).padStart(2, "0") +
    "Z";
  return `${IS_SMOKE ? "smoke" : "sweep"}-${stamp}`;
}

// ── Pricing ───────────────────────────────────────────────────────────────

async function fetchPricing(): Promise<Map<string, PriceInfo>> {
  const response = await fetch(OPENROUTER_MODELS_URL, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
  });
  if (!response.ok) {
    console.warn(`Failed to fetch pricing (${response.status}); cost will be undefined`);
    return new Map();
  }
  const json = (await response.json()) as { data?: unknown[] };
  const map = new Map<string, PriceInfo>();
  for (const entry of json.data ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const m = entry as {
      id?: unknown;
      pricing?: { prompt?: unknown; completion?: unknown };
    };
    if (typeof m.id !== "string") continue;
    const prompt =
      typeof m.pricing?.prompt === "string" ? m.pricing.prompt : null;
    const completion =
      typeof m.pricing?.completion === "string" ? m.pricing.completion : null;
    if (prompt === null && completion === null) continue;
    map.set(m.id, { prompt, completion });
  }
  return map;
}

// ── OpenRouter primary call ───────────────────────────────────────────────

async function callPrimaryModel(args: {
  modelId: string;
  systemPrompt: string;
  userPrompt: string;
  timeoutMs: number;
}): Promise<
  | {
      ok: true;
      rawContent: string;
      usage?: OpenRouterChatResponse["usage"];
      latencyMs: number;
    }
  | {
      ok: false;
      reason: "timeout" | "http_error" | "empty" | "network_error";
      error: string;
      latencyMs: number;
    }
> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      signal: controller.signal,
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": APP_URL,
        "X-Title": APP_NAME,
      },
      body: JSON.stringify({
        model: args.modelId,
        messages: [
          { role: "system", content: args.systemPrompt },
          { role: "user", content: args.userPrompt },
        ],
        temperature: 0,
        max_tokens: 300,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reconstruction_payload",
            strict: true,
            schema: {
              type: "object",
              properties: {
                sentence: { type: "string" },
                confidence: { type: "string", enum: ["high", "medium", "low"] },
                matchedScriptId: { type: ["string", "null"] },
                usedSigns: { type: "array", items: { type: "string" } },
              },
              required: ["sentence", "confidence", "matchedScriptId", "usedSigns"],
              additionalProperties: false,
            },
          },
        },
      }),
    });
    const latencyMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        reason: "http_error",
        error: `HTTP ${response.status}: ${body.replace(/\s+/g, " ").slice(0, 300)}`,
        latencyMs,
      };
    }
    const json = (await response.json()) as OpenRouterChatResponse;
    const rawContent = json.choices?.[0]?.message?.content ?? "";
    if (!rawContent) {
      return { ok: false, reason: "empty", error: "empty completion", latencyMs };
    }
    return { ok: true, rawContent, usage: json.usage, latencyMs };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - startedAt);
    const err = error as { name?: string; message?: string };
    if (err?.name === "AbortError") {
      return { ok: false, reason: "timeout", error: "request aborted by timeout", latencyMs };
    }
    return {
      ok: false,
      reason: "network_error",
      error: String(err?.message ?? err ?? "unknown"),
      latencyMs,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Judge ─────────────────────────────────────────────────────────────────

async function judgeNaturalness(args: {
  actual: string;
  hearingContext: string;
}): Promise<number | undefined> {
  if (!args.actual.trim()) return undefined;
  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": APP_URL,
        "X-Title": APP_NAME,
      },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        messages: [
          { role: "system", content: NATURALNESS_RUBRIC },
          {
            role: "user",
            content: `Conversation context (last hearing line): ${args.hearingContext}\nReconstructed sentence: ${args.actual}`,
          },
        ],
        temperature: 0,
        seed: 42,
        max_tokens: 30,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as OpenRouterChatResponse;
    const text = json.choices?.[0]?.message?.content ?? "";
    const match = text.match(/"score"\s*:\s*([1-5])/);
    if (!match) return undefined;
    const score = Number(match[1]);
    return Number.isFinite(score) ? (score - 1) / 4 : undefined;
  } catch {
    return undefined;
  }
}

// ── Embedding ─────────────────────────────────────────────────────────────

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

function normalizeText(value: string): string {
  return (value.toLowerCase().match(/[a-z0-9']+/g) ?? []).join(" ");
}

async function sentenceSimilarity(actual: string, expected: string): Promise<number> {
  if (!actual || !expected) return 0;
  const normA = normalizeText(actual);
  const normB = normalizeText(expected);
  if (normA === normB) return 1;
  try {
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: [actual, expected],
      }),
    });
    if (!response.ok) return 0;
    const json = (await response.json()) as OpenRouterEmbeddingResponse;
    const a = json.data?.[0]?.embedding;
    const b = json.data?.[1]?.embedding;
    if (!a || !b || a.length !== b.length) return 0;
    return cosine(a, b);
  } catch {
    return 0;
  }
}

// ── Concurrency primitive ─────────────────────────────────────────────────

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active += 1;
  }

  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}

const judgeGate = new Semaphore(JUDGE_CONCURRENCY);
const embeddingGate = new Semaphore(JUDGE_CONCURRENCY);

async function withSemaphore<T>(gate: Semaphore, fn: () => Promise<T>): Promise<T> {
  await gate.acquire();
  try {
    return await fn();
  } finally {
    gate.release();
  }
}

// ── Per-case runner ───────────────────────────────────────────────────────

async function runOneCase(args: {
  runId: string;
  runDir: string;
  modelId: string;
  systemPrompt: string;
  userTemplate: string;
  testCase: PromptTestCase;
  pricing: PriceInfo | null;
}): Promise<RawResultRecord> {
  const startedTotal = performance.now();
  const userPrompt = composeUserPrompt(args.userTemplate, args.testCase);

  let attempt = 0;
  let primary = await callPrimaryModel({
    modelId: args.modelId,
    systemPrompt: args.systemPrompt,
    userPrompt,
    timeoutMs: MODEL_TIMEOUT_MS,
  });
  while (!primary.ok && attempt < PRIMARY_RETRY_ATTEMPTS && primary.reason !== "timeout") {
    attempt += 1;
    primary = await callPrimaryModel({
      modelId: args.modelId,
      systemPrompt: args.systemPrompt,
      userPrompt,
      timeoutMs: MODEL_TIMEOUT_MS,
    });
  }

  const rawContent = primary.ok ? primary.rawContent : "";
  const parse = parseReconstructionPayload(rawContent);
  const actualSentence = parse.parsed?.sentence ?? "";

  const hearingContext =
    args.testCase.hearingTranscript[args.testCase.hearingTranscript.length - 1] ?? "";

  const [embeddingValue, naturalnessValue] = await Promise.all([
    EMBEDDINGS_ENABLED && actualSentence
      ? withSemaphore(embeddingGate, () =>
          sentenceSimilarity(actualSentence, args.testCase.expected.sentence),
        )
      : Promise.resolve(0),
    JUDGE_ENABLED && actualSentence
      ? withSemaphore(judgeGate, () =>
          judgeNaturalness({ actual: actualSentence, hearingContext }),
        )
      : Promise.resolve(undefined as number | undefined),
  ]);

  const score = scoreResponse(parse, args.testCase, embeddingValue, naturalnessValue);
  const usage = primary.ok ? normalizeUsage(primary.usage) : undefined;
  const costUsd = usage && args.pricing ? computeCostUsd(usage, args.pricing) : undefined;

  const record: RawResultRecord = {
    runId: args.runId,
    createdAt: new Date().toISOString(),
    modelId: args.modelId,
    strategyId: STRATEGY_ID,
    suite: args.testCase.suite,
    caseId: args.testCase.id,
    baseTurnId: args.testCase.baseTurnId,
    topic: args.testCase.topic,
    judgeEnabled: JUDGE_ENABLED,
    embeddingsEnabled: EMBEDDINGS_ENABLED,
    input: {
      hearingTranscript: args.testCase.hearingTranscript,
      recognizedSigns: args.testCase.recognizedSigns,
      signTokensTopK: args.testCase.signTokensTopK,
      expected: args.testCase.expected,
      notes: args.testCase.notes,
    },
    prompt: { system: args.systemPrompt, user: userPrompt },
    response: {
      rawContent,
      parsed: parse.parsed,
      parseError: parse.error,
      ...(usage ? { usage } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    score,
    ...(naturalnessValue !== undefined ? { naturalness: naturalnessValue } : {}),
    embeddingSimilarity: embeddingValue,
    latencyMs: primary.latencyMs,
    totalElapsedMs: Math.round(performance.now() - startedTotal),
    status: primary.ok ? "ok" : primary.reason,
    ...(primary.ok ? {} : { error: primary.error }),
    retries: attempt,
    providerPricing: args.pricing,
  };

  await writeJson(rawResultPath(args.runDir, args.modelId, args.testCase), record);
  return record;
}

function normalizeUsage(
  usage: OpenRouterChatResponse["usage"] | undefined,
): { inputTokens?: number; outputTokens?: number; totalTokens?: number } | undefined {
  if (!usage) return undefined;
  const result: { inputTokens?: number; outputTokens?: number; totalTokens?: number } = {};
  if (typeof usage.prompt_tokens === "number") result.inputTokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === "number") result.outputTokens = usage.completion_tokens;
  if (typeof usage.total_tokens === "number") result.totalTokens = usage.total_tokens;
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Orchestrator ──────────────────────────────────────────────────────────

async function runSweep(): Promise<void> {
  const strategy = getStrategy(STRATEGY_ID);
  if (!strategy) throw new Error(`Missing strategy: ${STRATEGY_ID}`);

  const runId = currentRunId();
  const runDir = resolve(
    SCRIPT_DIR,
    "..",
    "..",
    "results",
    "lean-options-sweep",
    runId,
  );
  await mkdir(runDir, { recursive: true });

  const pricing = await fetchPricing();

  // Smoke subset: clean + confusion-pair × first 2 script turns (turn_01, turn_02).
  const cases = IS_SMOKE
    ? ALL_CASES.filter(
        (testCase) =>
          (testCase.suite === "clean" || testCase.suite === "confusion-pair") &&
          (testCase.baseTurnId === "turn_01" || testCase.baseTurnId === "turn_02"),
      )
    : ALL_CASES;

  const totalWork = cases.length * MODEL_IDS.length;

  const manifest = {
    runId,
    createdAt: new Date().toISOString(),
    mode: IS_SMOKE ? "smoke" : "full",
    strategyId: STRATEGY_ID,
    judgeModel: JUDGE_ENABLED ? JUDGE_MODEL : null,
    embeddingModel: EMBEDDINGS_ENABLED ? EMBEDDING_MODEL : null,
    judgeEnabled: JUDGE_ENABLED,
    embeddingsEnabled: EMBEDDINGS_ENABLED,
    modelConcurrency: MODEL_CONCURRENCY,
    judgeConcurrency: JUDGE_CONCURRENCY,
    modelTimeoutMs: MODEL_TIMEOUT_MS,
    models: MODEL_IDS,
    cases: cases.map((testCase) => ({
      id: testCase.id,
      suite: testCase.suite,
      topic: testCase.topic,
      baseTurnId: testCase.baseTurnId,
    })),
    totalCases: cases.length,
    totalCalls: totalWork,
  };
  await writeJson(join(runDir, "manifest.json"), manifest);

  console.log(
    `Sweep ${runId} — ${IS_SMOKE ? "SMOKE" : "FULL"} — ${MODEL_IDS.length} models × ${cases.length} cases = ${totalWork} calls`,
  );
  console.log(`  out: ${runDir}`);
  console.log(
    `  judge: ${JUDGE_ENABLED ? JUDGE_MODEL : "disabled"}  embeddings: ${EMBEDDINGS_ENABLED ? EMBEDDING_MODEL : "disabled"}  force: ${FORCE}`,
  );

  const work: Array<{ modelId: string; testCase: PromptTestCase }> = [];
  for (const modelId of MODEL_IDS) {
    for (const testCase of cases) {
      work.push({ modelId, testCase });
    }
  }

  const state: ProgressState = {
    total: work.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    startedAt: Date.now(),
  };
  let nextIndex = 0;

  const tick = () => {
    const now = Date.now();
    const elapsedSec = Math.max(1, Math.round((now - state.startedAt) / 1000));
    const done = state.completed + state.skipped;
    const rate = done / elapsedSec;
    const remaining = state.total - done;
    const etaSec = rate > 0 ? Math.round(remaining / rate) : 0;
    process.stdout.write(
      `\r[${done}/${state.total}] skipped=${state.skipped} failed=${state.failed} ` +
        `rate=${rate.toFixed(2)}/s eta=${Math.floor(etaSec / 60)}m${etaSec % 60}s   `,
    );
  };

  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= work.length) return;
      const item = work[index];
      if (!item) return;

      const outPath = rawResultPath(runDir, item.modelId, item.testCase);
      if (!FORCE && existsSync(outPath)) {
        state.skipped += 1;
        tick();
        continue;
      }

      try {
        const record = await runOneCase({
          runId,
          runDir,
          modelId: item.modelId,
          systemPrompt: strategy.systemPrompt,
          userTemplate: strategy.userTemplate,
          testCase: item.testCase,
          pricing: pricing.get(item.modelId) ?? null,
        });
        state.completed += 1;
        if (record.status !== "ok" || !record.response.parsed) state.failed += 1;
      } catch (error) {
        state.failed += 1;
        const message = error instanceof Error ? error.message : String(error);
        console.error(`\n  [ERROR] ${item.modelId} ${item.testCase.id}: ${message}`);
      }
      tick();
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(MODEL_CONCURRENCY, work.length) }, () => worker()),
  );

  process.stdout.write("\n");

  const elapsedSec = Math.round((Date.now() - state.startedAt) / 1000);
  console.log(
    `Sweep finished in ${Math.floor(elapsedSec / 60)}m${elapsedSec % 60}s. ` +
      `completed=${state.completed} skipped=${state.skipped} failed=${state.failed}`,
  );

  console.log("Summarizing...");
  await summarizeRun({ runDir, modelIds: MODEL_IDS });
  console.log("Done.");
}

runSweep().catch((error) => {
  console.error(error);
  process.exit(1);
});
