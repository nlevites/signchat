"use client";

import type { ReconstructionPayload } from "@/lib/contracts";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";
import {
  composeUserPrompt,
  LEAN_OPTIONS_SYSTEM,
  type SignTokenTopK,
} from "./prompt";

/**
 * Browser-direct OpenRouter chat-completions wrapper that the OpenRouter
 * pane (Phase 3) and the end-to-end pane (Phase 6) both call. The hop is
 * browser → openrouter.ai, never traversing Vercel — see
 * ARCHITECTURE.md §5.7 / §11.1.
 *
 * Response_format uses json_schema strict (not json_object) because the
 * prompt-tester sweep (RESULTS.md) confirmed the strict schema works
 * across all dropdown models without any healing pass. ARCHITECTURE.md
 * §11.1 lists json_object as the contract; we tighten it here because the
 * stronger contract is empirically supported.
 */

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const APP_URL = "https://signchat.org";
const APP_NAME = "Signchat";

export type OpenRouterModelId = string;

export interface ReconstructionRequest {
  /** OpenRouter session key minted by /api/openrouter/session-key. */
  apiKey: string;
  modelId: OpenRouterModelId;
  /** Free-form hearing-side transcript line; "" is treated as "(none)". */
  hearingTranscript: string;
  /** Per-frame top-K classifier output for the current sign turn. */
  topK: ReadonlyArray<SignTokenTopK>;
  /**
   * Optional pricing override (per-token USD). When omitted, costUsd is
   * not derived. Format mirrors OpenRouter's /models endpoint:
   * `{ promptPrice: "0.0000003", completionPrice: "0.0000025" }` (USD per
   * 1 token, as decimal strings).
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
  /** Raw `choices[0].message.content` from OpenRouter — usually the JSON string. */
  raw: string;
  latencyMs: number;
  modelId: OpenRouterModelId;
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
 * does not satisfy the ReconstructionPayload shape.
 */
export async function reconstruct(
  req: ReconstructionRequest,
): Promise<ReconstructionResult> {
  const userPrompt = composeUserPrompt({
    hearingTranscript: req.hearingTranscript,
    topK: req.topK,
  });
  const turnId = newTurnId();
  mark("openrouter.reconstruct", turnId, "start");

  LogBus.info("openrouter", "reconstruct started", {
    modelId: req.modelId,
    topKLength: req.topK.length,
    hearingChars: req.hearingTranscript.length,
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
      body: JSON.stringify({
        model: req.modelId,
        messages: [
          { role: "system", content: LEAN_OPTIONS_SYSTEM },
          { role: "user", content: userPrompt },
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
                confidence: {
                  type: "string",
                  enum: ["high", "medium", "low"],
                },
                matchedScriptId: { type: ["string", "null"] },
                usedSigns: { type: "array", items: { type: "string" } },
              },
              required: [
                "sentence",
                "confidence",
                "matchedScriptId",
                "usedSigns",
              ],
              additionalProperties: false,
            },
          },
        },
      }),
    });
  } catch (err) {
    mark("openrouter.reconstruct", turnId, "end");
    LogBus.error("openrouter", "fetch failed", { error: errMsg(err) });
    throw err;
  }

  const latencyMs = Math.round(performance.now() - startedAt);

  if (!res.ok) {
    mark("openrouter.reconstruct", turnId, "end");
    const body = await res.text().catch(() => "");
    LogBus.error("openrouter", `HTTP ${res.status}`, {
      bodyPreview: body.slice(0, 200),
    });
    throw new Error(
      `OpenRouter ${res.status}: ${body.slice(0, 300) || res.statusText}`,
    );
  }

  let json: OpenRouterChatResponse;
  try {
    json = (await res.json()) as OpenRouterChatResponse;
  } catch (err) {
    mark("openrouter.reconstruct", turnId, "end");
    LogBus.error("openrouter", "non-JSON response body", {
      error: errMsg(err),
    });
    throw new Error(`OpenRouter returned non-JSON body`);
  }

  const raw = json.choices?.[0]?.message?.content ?? "";
  const parsed = parsePayload(raw);
  if (!parsed) {
    mark("openrouter.reconstruct", turnId, "end");
    LogBus.error("openrouter", "schema violation", {
      rawPreview: raw.slice(0, 200),
    });
    throw new Error(`OpenRouter response did not match ReconstructionPayload`);
  }

  const usage = extractUsage(json);
  const costUsd = computeCostUsd(usage, req.pricing ?? null);

  mark("openrouter.reconstruct", turnId, "end");
  LogBus.info("openrouter", "reconstruct ok", {
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
    systemPrompt: LEAN_OPTIONS_SYSTEM,
    userPrompt,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

function parsePayload(raw: string): ReconstructionPayload | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (typeof o.sentence !== "string" || o.sentence.length === 0) return null;
  if (
    o.confidence !== "high" &&
    o.confidence !== "medium" &&
    o.confidence !== "low"
  ) {
    return null;
  }
  if (o.matchedScriptId !== null && typeof o.matchedScriptId !== "string") {
    return null;
  }
  if (
    !Array.isArray(o.usedSigns) ||
    !o.usedSigns.every((s) => typeof s === "string")
  ) {
    return null;
  }
  const result: ReconstructionPayload = {
    sentence: o.sentence,
    confidence: o.confidence,
    matchedScriptId: o.matchedScriptId,
    usedSigns: o.usedSigns,
  };
  if (typeof o.needsClarification === "boolean") {
    result.needsClarification = o.needsClarification;
  }
  return result;
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
