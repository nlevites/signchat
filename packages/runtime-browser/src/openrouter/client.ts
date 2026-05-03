import type { ReconstructionPayload } from "@signchat/contracts";
import {
  buildReconstructionRequest,
  parseReconstructionResponse,
  ReconstructionParseError,
  type ReconstructionModelId,
  type SignTokenAlternative,
  type SignTokenTopK,
} from "@signchat/prompts";
import { log } from "../logger";
import { mark, newTurnId } from "../diagnostics/mark";

/**
 * Browser-direct OpenRouter chat-completions wrapper used by <DeafSession>
 * and by the Bridge renderer.
 *
 * The hop is browser → openrouter.ai (never through Vercel) so the deaf-side
 * latency budget stays at one round trip — see ARCHITECTURE.md §5.7 / §11.1.
 *
 * Body construction and response parsing are delegated to @signchat/prompts,
 * which owns the lean-options template (winner of the prompt-tester sweep —
 * see prompt-tester-service/charts/RESULTS.md). This file just owns the
 * network call, abort/cancel handling, latency markers, and the /models
 * catalog lookup the pane uses for pricing.
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const APP_URL = "https://signchat.org";
const APP_NAME = "Signchat";

export type OpenRouterModelId = ReconstructionModelId;
export type { SignTokenAlternative, SignTokenTopK };

export interface ReconstructRequest {
  /** OpenRouter session key minted by /api/openrouter/session-key. */
  apiKey: string;
  modelId: ReconstructionModelId;
  /**
   * Recent dialog history formatted as `You said: ...` / `They said: ...`
   * lines from the Deaf signer's perspective. Empty/whitespace becomes
   * "(none)".
   */
  recentDialog: string;
  /** Per-frame top-K classifier output for the current sign turn. */
  topK: ReadonlyArray<SignTokenTopK>;
  /**
   * Optional pricing override (per-token USD). When omitted, costUsd is not
   * derived. Format mirrors OpenRouter's /models entries:
   * `{ promptPrice: "0.0000003", completionPrice: "0.0000025" }`.
   */
  pricing?: Pricing | null;
  /**
   * Optional `AbortSignal` so the pane can cancel an in-flight call when
   * the user hits Disconnect or navigates away.
   */
  signal?: AbortSignal;
}

export interface Pricing {
  /** USD per 1 input token. Decimal string per OpenRouter catalog format. */
  promptPrice: string | null;
  /** USD per 1 output token. Decimal string per OpenRouter catalog format. */
  completionPrice: string | null;
}

export interface ReconstructionUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ReconstructionResult {
  parsed: ReconstructionPayload;
  /** Raw `choices[0].message.content` from OpenRouter — the JSON string. */
  raw: string;
  latencyMs: number;
  modelId: ReconstructionModelId;
  systemPrompt: string;
  userPrompt: string;
  usage?: ReconstructionUsage;
  costUsd?: number;
}

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

/**
 * Send one reconstruction call and return the parsed payload. Throws on
 * non-2xx, on missing `choices[0].message.content`, or on a JSON body that
 * does not satisfy the ReconstructionPayload schema.
 */
export async function reconstruct(
  req: ReconstructRequest,
): Promise<ReconstructionResult> {
  const body = buildReconstructionRequest({
    recentDialog: req.recentDialog,
    topK: req.topK,
    modelId: req.modelId,
  });
  const [systemMessage, userMessage] = body.messages;
  const systemPrompt = systemMessage?.content ?? "";
  const userPrompt = userMessage?.content ?? "";

  const turnId = newTurnId();
  mark("openrouter.reconstruct", turnId, "start");

  log.info("openrouter", "reconstruct started", {
    modelId: req.modelId,
    topKLength: req.topK.length,
    dialogChars: req.recentDialog.length,
  });

  const startedAt = performance.now();
  let res: Response;
  try {
    res = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      cache: "no-store",
      ...(req.signal ? { signal: req.signal } : {}),
      headers: {
        Authorization: `Bearer ${req.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": APP_URL,
        "X-Title": APP_NAME,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    mark("openrouter.reconstruct", turnId, "end");
    log.error("openrouter", "fetch failed", { error: errMsg(err) });
    throw err;
  }

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!res.ok) {
    mark("openrouter.reconstruct", turnId, "end");
    const errBody = await res.text().catch(() => "");
    log.error("openrouter", `HTTP ${res.status}`, {
      bodyPreview: errBody.slice(0, 200),
    });
    throw new Error(
      `OpenRouter ${res.status}: ${errBody.slice(0, 300) || res.statusText}`,
    );
  }

  let json: OpenRouterChatResponse;
  try {
    json = (await res.json()) as OpenRouterChatResponse;
  } catch (err) {
    mark("openrouter.reconstruct", turnId, "end");
    log.error("openrouter", "non-JSON response body", {
      error: errMsg(err),
    });
    throw new Error(`OpenRouter returned non-JSON body`);
  }

  const raw = json.choices?.[0]?.message?.content ?? "";
  let parsed: ReconstructionPayload;
  try {
    parsed = parseReconstructionResponse(safeJsonParse(raw));
  } catch (err) {
    mark("openrouter.reconstruct", turnId, "end");
    log.error("openrouter", "schema violation", {
      rawPreview: raw.slice(0, 200),
      error: errMsg(err),
    });
    if (err instanceof ReconstructionParseError) throw err;
    throw new Error(`OpenRouter response did not match ReconstructionPayload`);
  }

  const usage = extractUsage(json);
  const costUsd = computeCostUsd(usage, req.pricing ?? null);

  mark("openrouter.reconstruct", turnId, "end");
  log.info("openrouter", "reconstruct ok", {
    modelId: req.modelId,
    latencyMs,
    confidence: parsed.confidence,
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  });

  return {
    parsed,
    raw,
    latencyMs,
    modelId: req.modelId,
    systemPrompt,
    userPrompt,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function safeJsonParse(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new ReconstructionParseError(
      "OpenRouter returned non-JSON content",
      { cause: err },
    );
  }
}

function extractUsage(
  json: OpenRouterChatResponse,
): ReconstructionUsage | undefined {
  const u = json.usage;
  if (!u) return undefined;
  const out: ReconstructionUsage = {};
  if (typeof u.prompt_tokens === "number") out.inputTokens = u.prompt_tokens;
  if (typeof u.completion_tokens === "number") {
    out.outputTokens = u.completion_tokens;
  }
  if (typeof u.total_tokens === "number") out.totalTokens = u.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

function computeCostUsd(
  usage: ReconstructionUsage | undefined,
  pricing: Pricing | null,
): number | undefined {
  if (!usage || !pricing) return undefined;
  const promptPrice =
    pricing.promptPrice && Number.isFinite(Number(pricing.promptPrice))
      ? Number(pricing.promptPrice)
      : null;
  const completionPrice =
    pricing.completionPrice &&
    Number.isFinite(Number(pricing.completionPrice))
      ? Number(pricing.completionPrice)
      : null;
  if (promptPrice === null && completionPrice === null) return undefined;
  let cost = 0;
  if (promptPrice !== null && typeof usage.inputTokens === "number") {
    cost += promptPrice * usage.inputTokens;
  }
  if (completionPrice !== null && typeof usage.outputTokens === "number") {
    cost += completionPrice * usage.outputTokens;
  }
  return cost;
}

// === Catalog check ==========================================================

export interface OpenRouterCatalogEntry {
  id: string;
  name: string;
  pricing: Pricing | null;
}

interface OpenRouterModelsResponse {
  data?: Array<{
    id?: unknown;
    name?: unknown;
    pricing?: { prompt?: unknown; completion?: unknown } | null;
  }>;
}

/**
 * Fetch the OpenRouter models catalog (public, no auth needed) and return a
 * compact list of (id, name, pricing) entries. Used by the pane to
 * (a) flag any dropdown model id missing from the catalog, and (b) derive
 * per-token pricing for the cost display.
 */
export async function fetchOpenRouterCatalog(
  signal?: AbortSignal,
): Promise<OpenRouterCatalogEntry[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    cache: "force-cache",
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter /models ${res.status}`);
  }
  const json = (await res.json()) as OpenRouterModelsResponse;
  const data = Array.isArray(json.data) ? json.data : [];
  const out: OpenRouterCatalogEntry[] = [];
  for (const entry of data) {
    if (typeof entry.id !== "string") continue;
    const name = typeof entry.name === "string" ? entry.name : entry.id;
    const pricing = entry.pricing
      ? {
          promptPrice:
            typeof entry.pricing.prompt === "string"
              ? entry.pricing.prompt
              : null,
          completionPrice:
            typeof entry.pricing.completion === "string"
              ? entry.pricing.completion
              : null,
        }
      : null;
    out.push({ id: entry.id, name, pricing });
  }
  return out;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
