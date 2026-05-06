import type { Metadata } from "next";
import { PipelinePage } from "@/components/landing/PipelinePage";

export const metadata: Metadata = {
  title: "Signchat sign pipeline — seven stages, three packages, zero relays",
  description:
    "How Signchat turns sign tokens into fluent voice in under a second: MediaPipe → ONNX → admit → OpenRouter sentence → review → ElevenLabs streaming TTS. Browser-direct, no Signchat backend on the per-turn path.",
};

export default function PipelineRoute() {
  return <PipelinePage />;
}
