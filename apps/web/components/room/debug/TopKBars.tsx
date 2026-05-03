"use client";

import { cn } from "@/lib/cn";
import type { ClassifierResult } from "@signchat/runtime-browser/sign-pipeline/classifier";

export interface TopKBarsProps {
  result: ClassifierResult | null;
  /** Total bars rendered (pads with empty rows when result has fewer). Default 3. */
  rows?: number;
  className?: string;
}

export function TopKBars({ result, rows = 3, className }: TopKBarsProps) {
  const top = result?.top ?? [];
  const padded = Array.from({ length: rows }, (_, i) => top[i] ?? null);

  return (
    <div className={cn("space-y-1.5", className)}>
      {padded.map((entry, i) => {
        const score = entry?.score ?? 0;
        const label = entry?.label ?? "—";
        const isLeader = i === 0 && entry !== null;
        return (
          <div key={i} className="flex items-center gap-3">
            <span className="w-6 shrink-0 text-right font-mono t-meta text-sc-text-3">
              {i + 1}.
            </span>
            <span
              className={cn(
                "w-32 shrink-0 truncate font-mono t-body-sm",
                isLeader ? "text-sc-text" : "text-sc-text-2",
              )}
            >
              {label}
            </span>
            <div className="relative h-3 grow overflow-hidden rounded-sc-full bg-sc-surface-2">
              <div
                className={cn(
                  "absolute inset-y-0 left-0 transition-[width] duration-150",
                  isLeader ? "bg-sc-accent-500" : "bg-sc-border-strong",
                )}
                style={{ width: `${Math.max(0, Math.min(1, score)) * 100}%` }}
              />
            </div>
            <span className="w-12 shrink-0 text-right font-mono t-meta tabular-nums text-sc-text-2">
              {(score * 100).toFixed(1)}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
