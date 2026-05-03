import "server-only";

import type { OpenRouterModel } from "./types";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface OpenRouterModelsResponse {
  data?: unknown[];
}

export async function fetchOpenRouterModels(): Promise<readonly OpenRouterModel[]> {
  const upstream = await fetch(OPENROUTER_MODELS_URL, {
    cache: "no-store",
    headers: buildHeaders(),
  });

  if (!upstream.ok) {
    const body = await upstream.text().catch(() => "");
    throw new Error(`OpenRouter models ${upstream.status}: ${body.slice(0, 300)}`);
  }

  const json = (await upstream.json()) as OpenRouterModelsResponse;
  return (json.data ?? []).flatMap(toModel).sort((a, b) => a.id.localeCompare(b.id));
}

function buildHeaders(): HeadersInit {
  const headers: Record<string, string> = {
    accept: "application/json",
  };
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function toModel(value: unknown): OpenRouterModel[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const model = value as {
    id?: unknown;
    name?: unknown;
    context_length?: unknown;
    pricing?: {
      prompt?: unknown;
      completion?: unknown;
    };
  };
  if (typeof model.id !== "string") return [];
  return [
    {
      id: model.id,
      name: typeof model.name === "string" ? model.name : model.id,
      contextLength: typeof model.context_length === "number" ? model.context_length : null,
      promptPrice: typeof model.pricing?.prompt === "string" ? model.pricing.prompt : null,
      completionPrice:
        typeof model.pricing?.completion === "string" ? model.pricing.completion : null,
    },
  ];
}
