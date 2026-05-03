import { NextRequest } from "next/server";
import {
  DEFAULT_SYSTEM_PROMPT,
  DEFAULT_USER_TEMPLATE,
  getCase,
} from "@/lib/fixtures";
import { runStrategyOnce } from "@/lib/run-strategy";
import { getStrategy } from "@/lib/strategies";
import type {
  PriceInfo,
  PromptTesterRunRequest,
} from "@/lib/types";

const MAX_PROMPT_CHARS = 20_000;

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<Response> {
  if (!process.env.OPENROUTER_API_KEY?.trim()) {
    return Response.json({ error: "OPENROUTER_API_KEY is not configured" }, { status: 500 });
  }

  let body: PromptTesterRunRequest;
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

  const strategy = body.strategyId ? getStrategy(body.strategyId) : undefined;
  const systemPrompt = body.systemPrompt.trim()
    ? body.systemPrompt
    : strategy?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const userPromptTemplate = body.userPromptTemplate.trim()
    ? body.userPromptTemplate
    : strategy?.userTemplate ?? DEFAULT_USER_TEMPLATE;

  const judgeEnabled = req.nextUrl.searchParams.get("judge") !== "0";

  try {
    const result = await runStrategyOnce({
      modelId: body.modelId,
      systemPrompt,
      userPromptTemplate,
      testCase,
      strategyId: strategy?.id ?? null,
      pricing: body.pricing ?? null,
      judgeEnabled,
    });
    return Response.json(result);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 502 });
  }
}

function parseRequest(value: unknown): PromptTesterRunRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be an object");
  }
  const body = value as Partial<PromptTesterRunRequest>;
  const modelId = readRequiredString(body.modelId, "modelId");
  const caseId = readRequiredString(body.caseId, "caseId");
  const systemPrompt = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const userPromptTemplate =
    typeof body.userPromptTemplate === "string" ? body.userPromptTemplate : "";
  const strategyId = typeof body.strategyId === "string" && body.strategyId.trim().length > 0
    ? body.strategyId.trim()
    : null;
  if (systemPrompt.length + userPromptTemplate.length > MAX_PROMPT_CHARS) {
    throw new Error(`Prompts exceed ${MAX_PROMPT_CHARS} characters`);
  }
  const request: PromptTesterRunRequest = {
    modelId,
    caseId,
    systemPrompt,
    userPromptTemplate,
  };
  if (strategyId) {
    request.strategyId = strategyId;
  }
  const pricing = readPricing(body.pricing);
  if (pricing) {
    request.pricing = pricing;
  }
  return request;
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
