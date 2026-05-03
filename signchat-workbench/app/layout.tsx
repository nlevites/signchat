import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SignChat Workbench",
  description:
    "Integration test harness for the SignChat Deaf-signer flow (LiveKit, OpenRouter, ElevenLabs).",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
