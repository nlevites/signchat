import "server-only";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const DEFAULT_MODEL = "openai/text-embedding-3-large";

interface OpenRouterEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>;
}

// Returns 1.0 for identical normalized strings (agrees with sentenceExact).
// Otherwise returns remote cosine similarity from OpenRouter — enabled by
// default; opt out with OPENROUTER_EMBEDDINGS=0. Returns 0 when the remote
// call fails or is disabled — no local fallback, no false credit.
export async function sentenceSimilarity(actual: string, expected: string): Promise<number> {
  if (!actual || !expected) return 0;
  const normalizedActual = normalize(actual);
  const normalizedExpected = normalize(expected);
  if (normalizedActual === normalizedExpected) return 1;

  if (process.env.OPENROUTER_EMBEDDINGS !== "0") {
    const remote = await tryRemoteEmbedding(actual, expected);
    if (remote !== null) return remote;
  }
  return 0;
}

async function tryRemoteEmbedding(actual: string, expected: string): Promise<number | null> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return null;
  try {
    const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.OPENROUTER_EMBEDDING_MODEL?.trim() || DEFAULT_MODEL,
        input: [actual, expected],
      }),
    });
    if (!response.ok) return null;
    const json = (await response.json()) as OpenRouterEmbeddingResponse;
    const a = json.data?.[0]?.embedding;
    const b = json.data?.[1]?.embedding;
    if (!a || !b || a.length !== b.length) return null;
    return cosine(a, b);
  } catch {
    return null;
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const valueA = a[i] ?? 0;
    const valueB = b[i] ?? 0;
    dot += valueA * valueB;
    normA += valueA * valueA;
    normB += valueB * valueB;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(normA) * Math.sqrt(normB))));
}

function normalize(text: string): string {
  return (text.toLowerCase().match(/[a-z0-9']+/g) ?? []).join(" ");
}
