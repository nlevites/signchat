import type { Metadata } from "next";
import { ArchitecturePage } from "@/components/landing/ArchitecturePage";

export const metadata: Metadata = {
  title: "Signchat architecture — sign-end to first audible byte in ~0.6 s",
  description:
    "How Signchat actually works: a guided index into ARCHITECTURE.md. Browser-direct LiveKit + OpenRouter + ElevenLabs, no Signchat-operated relay, no fallback voices, no NEXT_PUBLIC_* secrets.",
};

export default function ArchitectureRoute() {
  return <ArchitecturePage />;
}
