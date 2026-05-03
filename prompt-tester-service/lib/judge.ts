import "server-only";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_JUDGE_MODEL = "openai/gpt-5.4-mini";

const NATURALNESS_RUBRIC = `You score how natural and contextually appropriate a reconstructed sentence is given a conversation context.

Rubric (1 to 5):
1 = unnatural, nonsensical, or off-topic
2 = stilted or awkward English
3 = OK but flat
4 = natural and on-topic
5 = natural, on-topic, and matches the hearing user's tone (echoing words like "usually" from their question is a positive signal)

Reply with strict JSON only: {"score": <integer 1-5>}.`;

interface JudgeChatResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

export async function judgeNaturalness(input: {
  actual: string;
  hearingContext: string;
}): Promise<number | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey || !input.actual.trim()) return undefined;
  const model = process.env.OPENROUTER_JUDGE_MODEL?.trim() || DEFAULT_JUDGE_MODEL;
  try {
    const response = await fetch(OPENROUTER_CHAT_URL, {
      method: "POST",
      cache: "no-store",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "HTTP-Referer": process.env.OPENROUTER_APP_URL?.trim() || "http://localhost:3003",
        "X-Title": process.env.OPENROUTER_APP_NAME?.trim() || "SignChat Prompt Tester",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: NATURALNESS_RUBRIC },
          {
            role: "user",
            content: `Conversation context (last hearing line): ${input.hearingContext}\nReconstructed sentence: ${input.actual}`,
          },
        ],
        temperature: 0,
        seed: 42,
        max_tokens: 30,
        response_format: { type: "json_object" },
      }),
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as JudgeChatResponse;
    const text = json.choices?.[0]?.message?.content ?? "";
    const match = text.match(/"score"\s*:\s*([1-5])/);
    if (!match) return undefined;
    const score = Number(match[1]);
    return Number.isFinite(score) ? (score - 1) / 4 : undefined;
  } catch {
    return undefined;
  }
}
