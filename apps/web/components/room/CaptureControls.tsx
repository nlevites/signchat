"use client";

import { Play, Stop, X } from "@phosphor-icons/react/dist/ssr";
import { useEffect, useState } from "react";
import type { CaptureMode, ModeState, SignBuffer } from "@signchat/contracts";
import { cn } from "@/lib/cn";

export interface CaptureControlsProps {
  mode: CaptureMode;
  state: ModeState;
  buffer: SignBuffer;
  silenceMs: number;
  /**
   * Wall-clock ms when the current sub-autoStopThreshold streak began.
   * Null when not in a streak; the silence countdown chip is hidden.
   */
  lowConfidenceStartedAt: number | null;
  canStart: boolean;
  onSetMode: (mode: CaptureMode) => void;
  onStart: () => void;
  onStopManual: () => void;
  onCancel: () => void;
  className?: string;
}

const MODE_OPTIONS = [
  { id: "auto", label: "Auto" },
  { id: "manual", label: "Manual" },
] as const satisfies ReadonlyArray<{ id: CaptureMode; label: string }>;

export function CaptureControls({
  mode,
  state,
  buffer,
  silenceMs,
  lowConfidenceStartedAt,
  canStart,
  onSetMode,
  onStart,
  onStopManual,
  onCancel,
  className,
}: CaptureControlsProps) {
  // Tick at 4Hz only while the auto silence countdown is on-screen so
  // we never call Date.now() during render (React compiler purity).
  const [nowMs, setNowMs] = useState(0);
  const isAutoCapturing = state === "capturing" && mode === "auto";
  const showCountdown = isAutoCapturing && lowConfidenceStartedAt !== null;
  useEffect(() => {
    if (!showCountdown) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, [showCountdown]);

  const isManualCapturing = state === "capturing" && mode === "manual";
  const silenceWaitMs =
    showCountdown && lowConfidenceStartedAt !== null && nowMs > 0
      ? Math.max(0, silenceMs - (nowMs - lowConfidenceStartedAt))
      : null;

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <ModeSegmented value={mode} onChange={onSetMode} />

      {state === "idle" ? (
        <button
          type="button"
          onClick={onStart}
          disabled={!canStart}
          className="sc-luminous inline-flex h-9 items-center gap-1.5 rounded-sc-full px-4 t-label transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
        >
          <Play size={14} weight="fill" />
          Start
        </button>
      ) : null}

      {isManualCapturing ? (
        <button
          type="button"
          onClick={onStopManual}
          disabled={buffer.tokens.length === 0}
          className="sc-luminous inline-flex h-9 items-center gap-1.5 rounded-sc-full px-4 t-label transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
        >
          <Stop size={14} weight="fill" />
          Stop
        </button>
      ) : null}

      {state === "capturing" ? (
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-9 items-center gap-1.5 rounded-sc-full border border-sc-border bg-sc-surface px-4 t-label text-sc-text transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-px hover:border-sc-border-strong hover:shadow-sc-sm"
        >
          <X size={14} weight="bold" />
          Cancel
        </button>
      ) : null}

      {silenceWaitMs !== null ? (
        <span className="inline-flex items-center rounded-sc-full bg-sc-accent-soft px-3 py-1 t-meta tabular-nums text-sc-accent-700">
          silence in {(Math.ceil(silenceWaitMs / 100) / 10).toFixed(1)}s
        </span>
      ) : null}
    </div>
  );
}

interface ModeSegmentedProps {
  value: CaptureMode;
  onChange: (mode: CaptureMode) => void;
}

function ModeSegmented({ value, onChange }: ModeSegmentedProps) {
  return (
    <div className="inline-flex rounded-sc-full border border-sc-border bg-sc-surface p-1">
      {MODE_OPTIONS.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            className={cn(
              "inline-flex h-7 items-center rounded-sc-full px-3 t-label transition-colors duration-150",
              active
                ? "bg-sc-accent-500 text-white shadow-sc-xs"
                : "text-sc-text-2 hover:text-sc-text",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
