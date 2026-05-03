"use client";

import type { ReconstructionModelId } from "@signchat/prompts";
import { useModeSnapshot } from "@signchat/runtime-browser/mode-controller/controller-store";
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
import {
  useDebugSignalsStore,
  usePreferencesStore,
  useRoomStore,
  useTranscriptStore,
} from "@/lib/stores";

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
        <h3 className="t-h3 mb-3 text-sc-text">Latency budgets</h3>
        <LatencyTable />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 md:col-span-2 xl:col-span-1">
        <h3 className="t-h3 mb-3 text-sc-text">Failure injection</h3>
        <FailureToggles />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Connection</h3>
        <ConnectionTable />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Mode controller</h3>
        <ModeSnapshotTable />
      </section>

      <section className="rounded-sc-xl border border-sc-border bg-sc-surface p-4">
        <h3 className="t-h3 mb-3 text-sc-text">Transcript</h3>
        <TranscriptStats />
      </section>
    </div>
  );
}

function ConnectionTable() {
  const state = useRoomStore((s) => s.connectionState);
  const roomId = useRoomStore((s) => s.roomId);
  const role = useRoomStore((s) => s.role);
  const identity = useRoomStore((s) => s.identity);
  const remote = useRoomStore((s) => s.remoteParticipant);
  return (
    <KvTable
      rows={[
        ["state", state],
        ["room", roomId ?? "—"],
        ["role", role ?? "—"],
        ["identity", identity ?? "—"],
        ["peer", remote ? `${remote.name} · ${remote.role}` : "—"],
      ]}
    />
  );
}

function ModeSnapshotTable() {
  const snap = useModeSnapshot();
  const prefs = usePreferencesStore((s) => s.thresholds);
  return (
    <KvTable
      rows={[
        ["state", snap.state],
        ["buffer tokens", String(snap.buffer.tokens.length)],
        ["silence ms", String(prefs.silenceMs)],
        ["interval ms", String(prefs.intervalMs)],
        [
          "low-conf since",
          snap.lowConfidenceStartedAt
            ? `${Math.max(0, Date.now() - snap.lowConfidenceStartedAt)} ms`
            : "—",
        ],
      ]}
    />
  );
}

function TranscriptStats() {
  const messages = useTranscriptStore((s) => s.messages);
  const partialCount = useTranscriptStore(
    (s) => Object.keys(s.partialsByUtterance).length,
  );
  const captionCount = messages.filter((m) => m.kind === "caption").length;
  const finalCount = messages.filter((m) => m.kind === "transcript_final").length;
  const chatCount = messages.filter((m) => m.kind === "chat").length;
  return (
    <KvTable
      rows={[
        ["messages total", String(messages.length)],
        ["captions", String(captionCount)],
        ["transcript finals", String(finalCount)],
        ["chat", String(chatCount)],
        ["live partials", String(partialCount)],
      ]}
    />
  );
}

function KvTable({ rows }: { rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <FragmentRow key={k} k={k} v={v} />
      ))}
    </dl>
  );
}

function FragmentRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt className="text-sc-text-3 uppercase tracking-wide t-meta">{k}</dt>
      <dd className="truncate font-mono text-sc-text">{v}</dd>
    </>
  );
}
