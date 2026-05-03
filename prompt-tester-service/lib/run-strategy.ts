import "server-only";

import { composeUserPrompt } from "./compose";
import { sentenceSimilarity } from "./embedding";
import { judgeNaturalness } from "./judge";
import { computeCostUsd, parseReconstructionPayload, scoreResponse } from "./scoring";
import type {
  PriceInfo,
  PromptTestCase,
  PromptTesterRunResponse,
} from "./types";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface RunStrategyOptions {
  modelId: string;
  systemPrompt: string;
  userPromptTemplate: string;
  testCase: PromptTestCase;
  strategyId: string | null;
  pricing: PriceInfo | null;
  judgeEnabled: boolean;
}

export async function runStrategyOnce(
  options: RunStrategyOptions,
): Promise<PromptTesterRunResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured");
  }

  const userPrompt = composeUserPrompt(options.userPromptTemplate, options.testCase);
  const startedAt = performance.now();
  const upstream = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "http://localhost:3003",
      "X-Title": process.env.OPENROUTER_APP_NAME?.trim() || "SignChat Prompt Tester",
    },
    body: JSON.stringify({
      model: options.modelId,
      messages: [
        { role: "system", content: options.systemPrompt },
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

  if (!upstream.ok) {
    const upstreamBody = await upstream.text().catch(() => "");
    throw new Error(`OpenRouter ${upstream.status}: ${upstreamBody.slice(0, 500)}`);
  }

  const json = (await upstream.json()) as OpenRouterChatResponse;
  const rawResponse = json.choices?.[0]?.message?.content ?? "";
  const parsed = parseReconstructionPayload(rawResponse);

  const expectedSentence = options.testCase.expected.sentence;
  const actualSentence = parsed.parsed?.sentence ?? "";
  const embeddingSim = await sentenceSimilarity(actualSentence, expectedSentence);
  const naturalness = options.judgeEnabled
    ? await judgeNaturalness({
        actual: actualSentence,
        hearingContext:
          options.testCase.hearingTranscript[options.testCase.hearingTranscript.length - 1] ?? "",
      })
    : undefined;
  const score = scoreResponse(parsed, options.testCase, embeddingSim, naturalness);

  const usage = buildUsage(json);
  const costUsd = computeCostUsd(usage, options.pricing);

  return {
    modelId: options.modelId,
    caseId: options.testCase.id,
    strategyId: options.strategyId,
    prompt: { system: options.systemPrompt, user: userPrompt },
    rawResponse,
    parsed: parsed.parsed,
    parseError: parsed.error,
    score,
    latencyMs,
    expected: options.testCase.expected,
    ...(usage ? { usage } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(naturalness !== undefined ? { naturalness } : {}),
  };
}

function buildUsage(
  response: OpenRouterChatResponse,
): PromptTesterRunResponse["usage"] | undefined {
  if (!response.usage) return undefined;
  const usage: NonNullable<PromptTesterRunResponse["usage"]> = {};
  if (typeof response.usage.prompt_tokens === "number") {
    usage.inputTokens = response.usage.prompt_tokens;
  }
  if (typeof response.usage.completion_tokens === "number") {
    usage.outputTokens = response.usage.completion_tokens;
  }
  if (typeof response.usage.total_tokens === "number") {
    usage.totalTokens = response.usage.total_tokens;
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}
