import { NextRequest } from "next/server";
import { getCase } from "@/lib/fixtures";
import { runStrategyOnce } from "@/lib/run-strategy";
import { STRATEGIES, getStrategy } from "@/lib/strategies";
import type {
  PriceInfo,
  PromptTesterCompareRequest,
  PromptTesterCompareResponse,
  PromptTesterRunResponse,
} from "@/lib/types";

const MAX_PROMPT_CHARS = 20_000;

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    return Response.json({ error: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  let body: PromptTesterCompareRequest;
  try {
    body = parseRequest(await req.json());
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }

  let testCase;
  try {
    testCase = getCase(body.caseId);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 400 });
  }

  const judgeEnabled = req.nextUrl.searchParams.get("judge") !== "0";

  const settled = await Promise.allSettled(
    body.strategyIds.map((strategyId) => {
      const strategy = getStrategy(strategyId);
      if (!strategy) {
        return Promise.reject(new Error(`Unknown strategy: ${strategyId}`));
      }
      const systemPrompt = body.systemPromptOverride ?? strategy.systemPrompt;
      const userPromptTemplate = body.userPromptTemplateOverride ?? strategy.userTemplate;
      return runStrategyOnce({
        modelId: body.modelId,
        systemPrompt,
        userPromptTemplate,
        testCase,
        strategyId: strategy.id,
        pricing: body.pricing ?? null,
        judgeEnabled,
      });
    }),
  );

  const results: PromptTesterRunResponse[] = [];
  const errors: { strategyId: string; error: string }[] = [];
  for (let i = 0; i < settled.length; i += 1) {
    const outcome = settled[i];
    const strategyId = body.strategyIds[i] ?? "(unknown)";
    if (!outcome) continue;
    if (outcome.status === "fulfilled") {
      results.push(outcome.value);
    } else {
      errors.push({ strategyId, error: errorMessage(outcome.reason) });
    }
  }

  const response: PromptTesterCompareResponse & {
    errors?: { strategyId: string; error: string }[];
  } = {
    caseId: testCase.id,
    modelId: body.modelId,
    results,
    ...(errors.length > 0 ? { errors } : {}),
  };
  return Response.json(response);
}

function parseRequest(value: unknown): PromptTesterCompareRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  const body = value as Partial<PromptTesterCompareRequest>;
  const modelId = readRequiredString(body.modelId, "modelId");
  const caseId = readRequiredString(body.caseId, "caseId");
  const strategyIds = readStrategyIds(body.strategyIds);
  const pricing = readPricing(body.pricing);
  const systemPromptOverride = readOptionalString(
    body.systemPromptOverride,
    "systemPromptOverride",
  );
  const userPromptTemplateOverride = readOptionalString(
    body.userPromptTemplateOverride,
    "userPromptTemplateOverride",
  );
  const totalChars =
    (systemPromptOverride?.length ?? 0) + (userPromptTemplateOverride?.length ?? 0);
  if (totalChars > MAX_PROMPT_CHARS) {
    throw new Error(`Prompt overrides exceed ${MAX_PROMPT_CHARS} characters`);
  }
  const request: PromptTesterCompareRequest = {
    modelId,
    caseId,
    strategyIds,
  };
  if (pricing) {
    request.pricing = pricing;
  }
  if (systemPromptOverride) {
    request.systemPromptOverride = systemPromptOverride;
  }
  if (userPromptTemplateOverride) {
    request.userPromptTemplateOverride = userPromptTemplateOverride;
  }
  return request;
}

function readOptionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  return value.trim().length > 0 ? value : null;
}

function readStrategyIds(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return STRATEGIES.map((strategy) => strategy.id);
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim().length > 0) ids.push(entry.trim());
  }
  if (ids.length === 0) {
    return STRATEGIES.map((strategy) => strategy.id);
  }
  return ids;
}

function readPricing(value: unknown): PriceInfo | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const pricing = value as Partial<PriceInfo>;
  const prompt = typeof pricing.prompt === "string" ? pricing.prompt : null;
  const completion = typeof pricing.completion === "string" ? pricing.completion : null;
  if (!prompt && !completion) return null;
  return { prompt, completion };
}

function readRequiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
