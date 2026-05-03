"use client";

import type { ReconstructionModelId } from "@signchat/prompts";
import { CameraPreview } from "@/components/room/debug/CameraPreview";
import { CaptureState } from "@/components/room/debug/CaptureState";
import { CatalogChip } from "@/components/room/debug/CatalogChip";
import { FailureToggles } from "@/components/room/debug/FailureToggles";
import { LatencyTable } from "@/components/room/debug/LatencyTable";
import { ModelPicker } from "@/components/room/debug/ModelPicker";
import { PromptInspector } from "@/components/room/debug/PromptInspector";
import { SessionInfo } from "@/components/room/debug/SessionInfo";
import { ThresholdSliders } from "@/components/room/debug/ThresholdSliders";
import { TopKBars } from "@/components/room/debug/TopKBars";
import { useDebugSignalsStore, usePreferencesStore } from "@/lib/stores";

const OPENROUTER_OPTIONS: ReadonlyArray<{
  value: ReconstructionModelId;
  label: string;
}> = [
  { value: "google/gemini-3-flash-preview", label: "google/gemini-3-flash-preview (default)" },
  { value: "openai/gpt-5.4-mini", label: "openai/gpt-5.4-mini" },
  { value: "anthropic/claude-haiku-4.5", label: "anthropic/claude-haiku-4.5" },
  { value: "x-ai/grok-4.1-fast", label: "x-ai/grok-4.1-fast" },
];

export function DebugView() {
  const modelId = usePreferencesStore((s) => s.modelId);
  const setModelId = usePreferencesStore((s) => s.setModelId);
  const cameraStream = useDebugSignalsStore((s) => s.cameraStream);
  const latestFrame = useDebugSignalsStore((s) => s.latestFrame);
  const latestResult = useDebugSignalsStore((s) => s.latestResult);

  return (
    <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Session</h3>
        <SessionInfo />
      </section>

      <section className="flex flex-col gap-3 rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h3 className="t-h3 text-sc-text">Models</h3>
          <CatalogChip />
        </div>
        <ModelPicker<ReconstructionModelId>
          label="OpenRouter model"
          value={modelId}
          options={OPENROUTER_OPTIONS}
          onChange={setModelId}
        />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Auto-mode thresholds</h3>
        <ThresholdSliders />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-2">
        <h3 className="t-h3 mb-3 text-sc-text">Sign capture overlay</h3>
        <div className="flex flex-col gap-3">
          <CameraPreview stream={cameraStream} frame={latestFrame} />
          <TopKBars result={latestResult} />
        </div>
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Capture state</h3>
        <CaptureState />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-3">
        <h3 className="t-h3 mb-3 text-sc-text">Reconstruct prompt</h3>
        <PromptInspector />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-2">
        <h3 className="t-h3 mb-3 text-sc-text">Latency vs §13 budgets</h3>
        <LatencyTable />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-1">
        <h3 className="t-h3 mb-3 text-sc-text">Failure injection</h3>
        <FailureToggles />
      </section>
    </div>
  );
}
