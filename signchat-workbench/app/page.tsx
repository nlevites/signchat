"use client";

import { useEffect, useState } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { LogStream } from "@/components/primitives/log-stream";
import { LobbyPane } from "@/components/panes/lobby-pane";
import { LiveKitPane } from "@/components/panes/livekit-pane";
import { OpenRouterPane } from "@/components/panes/openrouter-pane";
import { ElevenLabsPane } from "@/components/panes/elevenlabs-pane";
import { SignCapturePane } from "@/components/panes/sign-capture-pane";
import { EndToEndPane } from "@/components/panes/end-to-end-pane";
import { WhisperPane } from "@/components/panes/whisper-pane";
import { LatencyPane } from "@/components/panes/latency-pane";

type TabId =
  | "lobby"
  | "livekit"
  | "openrouter"
  | "elevenlabs"
  | "sign"
  | "e2e"
  | "whisper"
  | "latency";

interface Tab {
  id: TabId;
  label: string;
  description: string;
}

const TABS: readonly Tab[] = [
  { id: "lobby", label: "Lobby", description: "Mint credentials" },
  { id: "livekit", label: "LiveKit", description: "Transport + DataChannel" },
  { id: "openrouter", label: "OpenRouter", description: "Reconstruction LLM" },
  { id: "elevenlabs", label: "ElevenLabs", description: "Streaming TTS" },
  { id: "sign", label: "Sign capture", description: "FSM + admit logic" },
  { id: "e2e", label: "End-to-end", description: "Full Deaf-side turn" },
  { id: "whisper", label: "Whisper", description: "Hearing → captions" },
  { id: "latency", label: "Latency", description: "Per-stage p50/p95" },
];

export default function HomePage() {
  const [tab, setTab] = useState<TabId>("lobby");

  useEffect(() => {
    LogBus.info("workbench", "workbench mounted");
  }, []);

  return (
    <div className="min-h-screen pb-[300px]">
      <header className="border-b border-slate-700 bg-slate-900/60 backdrop-blur">
        <div className="mx-auto max-w-6xl px-6 py-5">
          <div className="flex items-baseline justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-50">
                SignChat Workbench
              </h1>
              <p className="mt-1 text-sm text-slate-400">
                Integration test harness for the Deaf-signer flow — LiveKit, OpenRouter,
                ElevenLabs. See{" "}
                <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
                  ARCHITECTURE.md
                </code>{" "}
                for the system this validates.
              </p>
            </div>
            <a
              href="/api/health"
              target="_blank"
              rel="noreferrer"
              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              /api/health
            </a>
          </div>
          <nav className="mt-5 flex flex-wrap gap-2">
            {TABS.map((t) => {
              const active = t.id === tab;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => {
                    setTab(t.id);
                    LogBus.debug("workbench", `switched to ${t.id} tab`);
                  }}
                  className={[
                    "rounded-lg border px-3 py-2 text-left text-sm transition-colors",
                    active
                      ? "border-sky-500/60 bg-sky-500/10 text-sky-100"
                      : "border-slate-700 bg-slate-800/40 text-slate-300 hover:border-slate-600 hover:bg-slate-800",
                  ].join(" ")}
                >
                  <div className="font-medium">{t.label}</div>
                  <div className="text-[11px] text-slate-400">{t.description}</div>
                </button>
              );
            })}
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8">
        {tab === "lobby" ? <LobbyPane /> : null}
        {tab === "livekit" ? <LiveKitPane /> : null}
        {tab === "openrouter" ? <OpenRouterPane /> : null}
        {tab === "elevenlabs" ? <ElevenLabsPane /> : null}
        {tab === "sign" ? <SignCapturePane /> : null}
        {tab === "e2e" ? <EndToEndPane /> : null}
        {tab === "whisper" ? <WhisperPane /> : null}
        {tab === "latency" ? <LatencyPane /> : null}
      </main>

      <LogStream />
    </div>
  );
}
