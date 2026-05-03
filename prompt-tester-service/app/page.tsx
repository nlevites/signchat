import type { Metadata } from "next";
import { PromptTesterClient } from "@/components/prompt-tester-client";
import { fetchOpenRouterModels } from "@/lib/openrouter-models";


export const metadata: Metadata = {
  title: "Prompt Tester",
  description: "Test and compare LLM prompt strategies for ASL-token reconstruction.",
};

export default async function HomePage() {
  const { models, modelLoadError } = await loadModels();
  return <PromptTesterClient initialModels={models} initialModelLoadError={modelLoadError} />;
}

async function loadModels() {
  try {
    return { models: await fetchOpenRouterModels(), modelLoadError: null };
  } catch (error) {
    return { models: [], modelLoadError: error instanceof Error ? error.message : String(error) };
  }
}
