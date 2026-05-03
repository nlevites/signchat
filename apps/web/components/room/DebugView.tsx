"use client";

import type { ReconstructionModelId } from "@signchat/prompts";
import { CameraPreview } from "@/components/room/debug/CameraPreview";
import { CatalogChip } from "@/components/room/debug/CatalogChip";
import { FailureToggles } from "@/components/room/debug/FailureToggles";
import { LatencyTable } from "@/components/room/debug/LatencyTable";
import { ModelPicker } from "@/components/room/debug/ModelPicker";
import { ThresholdSliders } from "@/components/room/debug/ThresholdSliders";
import { TopKBars } from "@/components/room/debug/TopKBars";
import {
  useDebugSignalsStore,
  usePreferencesStore,
  type WhisperModelId,
} from "@/lib/stores";

const OPENROUTER_OPTIONS: ReadonlyArray<{
  value: ReconstructionModelId;
  label: string;
}> = [
  { value: "google/gemini-3-flash-preview", label: "google/gemini-3-flash-preview" },
  { value: "anthropic/claude-haiku-4.5", label: "anthropic/claude-haiku-4.5" },
  { value: "x-ai/grok-4.1-fast", label: "x-ai/grok-4.1-fast" },
];

const WHISPER_OPTIONS: ReadonlyArray<{ value: WhisperModelId; label: string }> = [
  { value: "Xenova/whisper-tiny.en", label: "tiny.en (~40MB)" },
  { value: "Xenova/whisper-base.en", label: "base.en (~80MB)" },
  { value: "Xenova/whisper-small.en", label: "small.en (~250MB)" },
];

export function DebugView() {
  const modelId = usePreferencesStore((s) => s.modelId);
  const setModelId = usePreferencesStore((s) => s.setModelId);
  const whisperModelId = usePreferencesStore((s) => s.whisperModelId);
  const setWhisperModelId = usePreferencesStore((s) => s.setWhisperModelId);
  const cameraStream = useDebugSignalsStore((s) => s.cameraStream);
  const latestFrame = useDebugSignalsStore((s) => s.latestFrame);
  const latestResult = useDebugSignalsStore((s) => s.latestResult);

  return (
    <div className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-3">
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
        <ModelPicker<WhisperModelId>
          label="Whisper variant"
          value={whisperModelId}
          options={WHISPER_OPTIONS}
          onChange={setWhisperModelId}
        />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Auto-mode thresholds</h3>
        <ThresholdSliders />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Failure-mode injection</h3>
        <FailureToggles />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-1">
        <h3 className="t-h3 mb-3 text-sc-text">Sign capture overlay</h3>
        <div className="flex flex-col gap-3">
          <CameraPreview stream={cameraStream} frame={latestFrame} />
          <TopKBars result={latestResult} />
        </div>
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-2">
        <h3 className="t-h3 mb-3 text-sc-text">Latency vs §13 budgets</h3>
        <LatencyTable />
      </section>
    </div>
  );
}
