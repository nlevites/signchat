"use client";

import { type PreferenceThresholds, usePreferencesStore } from "@/lib/stores";
import { ControllerStore } from "@/lib/mode-controller/controller-store";
import { cn } from "@/lib/cn";

type ThresholdKey = keyof PreferenceThresholds;

interface SliderSpec {
  key: ThresholdKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
}

const SLIDERS: ReadonlyArray<SliderSpec> = [
  {
    key: "top1Threshold",
    label: "Top-1 threshold",
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: "top2Threshold",
    label: "Top-2 threshold",
    min: 0,
    max: 1,
    step: 0.05,
    format: (v) => v.toFixed(2),
  },
  {
    key: "silenceMs",
    label: "Silence window",
    min: 500,
    max: 5000,
    step: 100,
    format: (v) => `${v} ms`,
  },
  {
    key: "intervalMs",
    label: "Inference interval",
    min: 200,
    max: 1000,
    step: 50,
    format: (v) => `${v} ms`,
  },
  {
    key: "autoStartThreshold",
    label: "Auto start threshold",
    min: 0.05,
    max: 0.95,
    step: 0.01,
    format: (v) => `${(v * 100).toFixed(0)}%`,
  },
  {
    key: "autoStopThreshold",
    label: "Auto stop threshold",
    min: 0.001,
    max: 0.1,
    step: 0.005,
    format: (v) => `${(v * 100).toFixed(1)}%`,
  },
];

export interface ThresholdSlidersProps {
  className?: string;
}

export function ThresholdSliders({
  className,
}: ThresholdSlidersProps): React.ReactElement {
  const thresholds = usePreferencesStore((s) => s.thresholds);
  const setThresholds = usePreferencesStore((s) => s.setThresholds);

  const commit = (key: ThresholdKey, value: number): void => {
    setThresholds({ [key]: value });
    const next: PreferenceThresholds = { ...thresholds, [key]: value };
    ControllerStore.current()?.setThresholds({
      top1Threshold: next.top1Threshold,
      top2Threshold: next.top2Threshold,
      silenceMs: next.silenceMs,
      inferenceIntervalMs: next.intervalMs,
      autoStartThreshold: next.autoStartThreshold,
      autoStopThreshold: next.autoStopThreshold,
    });
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {SLIDERS.map((spec) => (
        <SliderRow
          key={spec.key}
          spec={spec}
          value={thresholds[spec.key]}
          onChange={(v) => commit(spec.key, v)}
        />
      ))}
    </div>
  );
}

interface SliderRowProps {
  spec: SliderSpec;
  value: number;
  onChange: (next: number) => void;
}

function SliderRow({ spec, value, onChange }: SliderRowProps) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-center justify-between gap-3">
        <span className="t-meta uppercase tracking-[0.06em] text-sc-text-2">
          {spec.label}
        </span>
        <span className="font-mono text-[12px] tabular-nums text-sc-text">
          {spec.format(value)}
        </span>
      </span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(e) => onChange(Number.parseFloat(e.target.value))}
        aria-label={spec.label}
        className="block w-full accent-sc-accent-500"
      />
    </label>
  );
}
