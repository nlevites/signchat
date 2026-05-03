import { fetchOpenRouterModels } from "@/lib/openrouter-models";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  try {
    const models = await fetchOpenRouterModels();
    return Response.json({ models });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: `OpenRouter model fetch failed: ${message}` }, { status: 502 });
  }
}
