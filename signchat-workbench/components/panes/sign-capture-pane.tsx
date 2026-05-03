"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { useLatencyStats } from "@/lib/diagnostics/latency-markers";
import type {
  ClassifierResult,
  ClassifierState,
} from "@/lib/sign-pipeline/classifier";
import {
  DEFAULT_CLASSIFIER_CONFIG,
  MediaPipeOnnxClassifier,
} from "@/lib/sign-pipeline/mediapipe-onnx-classifier";
import { clearModelCache } from "@/lib/sign-pipeline/model-cache";
import type { VisionFrame } from "@/lib/sign-pipeline/mediapipe-runner";
import { CameraPreview } from "@/components/primitives/camera-preview";
import { TopKBars } from "@/components/primitives/topk-bars";

type Source = "scripted" | "live";

const STAGES = ["mp.detect", "mp.assemble", "ort.tensor", "ort.run", "ort.topk"] as const;

const STAGE_BUDGETS_P50: Record<(typeof STAGES)[number], number> = {
  "mp.detect": 8,        // §13: MediaPipe per-frame on GPU delegate
  "mp.assemble": 1,
  "ort.tensor": 5,
  "ort.run": 50,         // §13: ONNX inference per tick (WASM EP)
  "ort.topk": 1,
};

export function SignCapturePane() {
  const [source, setSource] = useState<Source>("scripted");
  const [classifierState, setClassifierState] = useState<ClassifierState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [frame, setFrame] = useState<VisionFrame | null>(null);
  const [result, setResult] = useState<ClassifierResult | null>(null);
  const [progress, setProgress] = useState<{
    received: number;
    total: number | null;
    fromCache?: boolean;
  } | null>(null);
  const [intervalMs, setIntervalMs] = useState<number>(
    DEFAULT_CLASSIFIER_CONFIG.inferenceIntervalMs,
  );

  const classifierRef = useRef<MediaPipeOnnxClassifier | null>(null);

  useEffect(() => {
    LogBus.debug("sign", "sign capture pane mounted");
  }, []);

  // Tear down without touching React state directly. The classifier's
  // onStateChange("stopped") callback resets state via the same path as any
  // other lifecycle transition, so the cleanup is observable as an external
  // event rather than a synchronous setState-in-effect.
  const teardownClassifier = useCallback(async () => {
    const c = classifierRef.current;
    classifierRef.current = null;
    if (c) {
      try {
        await c.stop();
      } catch (err) {
        LogBus.warn("sign", "stop() threw", { err: String(err) });
      }
    }
  }, []);

  const startLive = useCallback(async () => {
    if (classifierRef.current) return;
    setError(null);
    setProgress({ received: 0, total: null });
    const classifier = new MediaPipeOnnxClassifier({
      config: { inferenceIntervalMs: intervalMs },
      onStream: setStream,
      onFrame: setFrame,
      onModelProgress: (received, total) => {
        setProgress({ received, total });
      },
    });
    classifier.onResult(setResult);
    classifier.onStateChange((state, err) => {
      setClassifierState(state);
      if (state === "error" && err) setError(err.message);
      if (state === "running") setProgress(null);
      if (state === "stopped" || state === "error" || state === "idle") {
        setStream(null);
        setFrame(null);
        if (state !== "error") setResult(null);
        if (state !== "error") setProgress(null);
      }
    });
    classifierRef.current = classifier;
    try {
      await classifier.start();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [intervalMs]);

  // Push slider changes into a running classifier.
  useEffect(() => {
    classifierRef.current?.setInferenceIntervalMs(intervalMs);
  }, [intervalMs]);

  const handleClearCache = useCallback(async () => {
    await clearModelCache();
    LogBus.info("sign", "model cache cleared");
  }, []);

  // Source-toggle effect: when scripted is chosen, tear down any live
  // classifier. The setState resets land via onStateChange("stopped") above.
  useEffect(() => {
    if (source === "live") return;
    void teardownClassifier();
  }, [source, teardownClassifier]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      void teardownClassifier();
    };
  }, [teardownClassifier]);

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold text-slate-100">Sign capture</h2>
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
              Phase 5b — live
            </span>
          </div>
          <div className="flex gap-1 rounded-md border border-slate-700 bg-slate-900 p-1 text-xs">
            {(["scripted", "live"] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSource(s)}
                className={[
                  "rounded px-3 py-1 transition-colors",
                  source === s
                    ? "bg-sky-500/20 text-sky-100"
                    : "text-slate-400 hover:text-slate-200",
                ].join(" ")}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
        <p className="text-sm text-slate-400">
          {source === "live"
            ? "MediaPipe Tasks Vision (face + hands + pose) feeds the 250-class asl-signs ONNX classifier. WASM execution provider; cadence 500ms. Mode controller FSM (Phase 5a) consumes top-K results."
            : "ScriptedClassifier replays a hand-authored timeline. Mode controller FSM consumes the resulting tokens identically to live mode. Wired up in Phase 5a."}
        </p>
      </header>

      {source === "live" ? (
        <LivePanel
          classifierState={classifierState}
          stream={stream}
          frame={frame}
          result={result}
          error={error}
          progress={progress}
          intervalMs={intervalMs}
          onIntervalMsChange={setIntervalMs}
          onClearCache={handleClearCache}
          onStart={() => void startLive()}
          onStop={() => void teardownClassifier()}
        />
      ) : (
        <ScriptedPlaceholder />
      )}
    </section>
  );
}

interface LivePanelProps {
  classifierState: ClassifierState;
  stream: MediaStream | null;
  frame: VisionFrame | null;
  result: ClassifierResult | null;
  error: string | null;
  progress: { received: number; total: number | null } | null;
  intervalMs: number;
  onIntervalMsChange: (ms: number) => void;
  onClearCache: () => void;
  onStart: () => void;
  onStop: () => void;
}

function LivePanel({
  classifierState,
  stream,
  frame,
  result,
  error,
  progress,
  intervalMs,
  onIntervalMsChange,
  onClearCache,
  onStart,
  onStop,
}: LivePanelProps) {
  const isRunning = classifierState === "running";
  const isStarting = classifierState === "starting";

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Camera + landmarks</h3>
          <StateBadge state={classifierState} />
        </div>
        <CameraPreview stream={stream} frame={frame} />
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isRunning ? (
            <button
              type="button"
              onClick={onStop}
              className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-500/20"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={onStart}
              disabled={isStarting}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-50"
            >
              {isStarting ? "Starting…" : "Start live"}
            </button>
          )}
          {progress ? <ProgressInline progress={progress} /> : null}
        </div>
        {error ? (
          <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
            {error}
          </div>
        ) : null}
        <div className="mt-4 space-y-3 border-t border-slate-800 pt-3">
          <label className="block">
            <div className="mb-1 flex items-center justify-between text-xs text-slate-300">
              <span>inference cadence</span>
              <span className="font-mono tabular-nums text-slate-100">
                {intervalMs}ms
              </span>
            </div>
            <input
              type="range"
              min={100}
              max={1500}
              step={50}
              value={intervalMs}
              onChange={(e) => onIntervalMsChange(Number.parseInt(e.target.value, 10))}
              className="block w-full accent-emerald-500"
            />
            <div className="mt-1 flex justify-between text-[10px] text-slate-500">
              <span>100ms</span>
              <span>500ms (default)</span>
              <span>1500ms</span>
            </div>
          </label>
          <button
            type="button"
            onClick={() => void onClearCache()}
            className="rounded-md border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
          >
            Clear model cache (IndexedDB)
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <h3 className="mb-3 text-sm font-semibold text-slate-100">Top-3 predictions</h3>
        <TopKBars result={result} rows={3} />
        <div className="mt-2 text-[11px] text-slate-500">
          {result
            ? `last update ${formatRelMs(result.ts)} ago`
            : isRunning
            ? "waiting for first window…"
            : "live not running"}
        </div>
        <h3 className="mb-2 mt-6 text-sm font-semibold text-slate-100">Stage latencies</h3>
        <LatencyStrip />
      </div>
    </div>
  );
}

function ProgressInline({ progress }: { progress: { received: number; total: number | null } }) {
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;
  const totalText = progress.total !== null ? mb(progress.total) : "?";
  return (
    <span className="text-xs text-slate-400">
      model {mb(progress.received)} / {totalText}
    </span>
  );
}

function ScriptedPlaceholder() {
  return (
    <div className="rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-8 text-center text-sm text-slate-400">
      Scripted mode lands in Phase 5a (FSM + admit logic + ScriptedClassifier).
      For now this pane is a live-mode demonstrator only — flip to{" "}
      <span className="font-mono text-slate-200">live</span> to use the
      MediaPipe + ONNX classifier.
    </div>
  );
}

function StateBadge({ state }: { state: ClassifierState }) {
  const palette: Record<ClassifierState, string> = {
    idle: "border-slate-600 bg-slate-700/30 text-slate-300",
    starting: "border-amber-500/40 bg-amber-500/10 text-amber-200",
    running: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
    error: "border-rose-500/40 bg-rose-500/10 text-rose-200",
    stopped: "border-slate-600 bg-slate-700/30 text-slate-400",
  };
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${palette[state]}`}
    >
      {state}
    </span>
  );
}

function LatencyStrip() {
  return (
    <ul className="space-y-1.5">
      {STAGES.map((stage) => (
        <LatencyRow key={stage} stage={stage} />
      ))}
    </ul>
  );
}

function LatencyRow({ stage }: { stage: (typeof STAGES)[number] }) {
  const stats = useLatencyStats(stage);
  const budget = STAGE_BUDGETS_P50[stage];
  const overP50 = stats !== null && stats.p50 > budget;
  const ratio = stats ? Math.min(1, stats.p50 / Math.max(budget * 2, 1)) : 0;
  return (
    <li className="flex items-center gap-3 text-xs">
      <span className="w-24 shrink-0 font-mono text-slate-300">{stage}</span>
      <div className="relative h-2 grow overflow-hidden rounded bg-slate-800">
        <div
          className={[
            "absolute inset-y-0 left-0",
            overP50 ? "bg-rose-500/70" : "bg-emerald-500/70",
          ].join(" ")}
          style={{ width: `${ratio * 100}%` }}
        />
        <div
          className="absolute inset-y-0 w-px bg-slate-500"
          style={{ left: `${50}%` }}
        />
      </div>
      <span className="w-24 shrink-0 text-right font-mono text-slate-400 tabular-nums">
        {stats
          ? `p50 ${Math.round(stats.p50)}ms · p95 ${Math.round(stats.p95)}ms`
          : `p50 — / budget ${budget}ms`}
      </span>
    </li>
  );
}

function formatRelMs(ts: number): string {
  const ms = performance.now() - ts;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
