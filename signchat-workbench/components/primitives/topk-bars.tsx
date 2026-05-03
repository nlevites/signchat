"use client";

import type { ClassifierResult } from "@/lib/sign-pipeline/classifier";

interface TopKBarsProps {
  result: ClassifierResult | null;
  /** Total bars rendered (pads with empty rows when result has fewer). Default 3. */
  rows?: number;
}

export function TopKBars({ result, rows = 3 }: TopKBarsProps) {
  const top = result?.top ?? [];
  const padded = Array.from({ length: rows }, (_, i) => top[i] ?? null);

  return (
    <div className="space-y-1.5">
      {padded.map((entry, i) => {
        const score = entry?.score ?? 0;
        const label = entry?.label ?? "—";
        const isLeader = i === 0 && entry !== null;
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="w-6 shrink-0 text-right font-mono text-xs text-slate-500">
              {i + 1}.
            </span>
            <span
              className={[
                "w-32 shrink-0 truncate font-mono text-sm",
                isLeader ? "text-slate-50" : "text-slate-300",
              ].join(" ")}
            >
              {label}
            </span>
            <div className="relative h-3 grow overflow-hidden rounded bg-slate-800">
              <div
                className={[
                  "absolute inset-y-0 left-0 transition-[width] duration-150",
                  isLeader ? "bg-emerald-500" : "bg-slate-500",
                ].join(" ")}
                style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-slate-300">
              {(score * 100).toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
