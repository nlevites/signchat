"use client";

import type { SignToken } from "@signchat/contracts";
import { cn } from "@/lib/cn";

export interface TokenChipStripProps {
  tokens: ReadonlyArray<SignToken>;
  className?: string;
}

export function TokenChipStrip({ tokens, className }: TokenChipStripProps) {
  if (tokens.length === 0) return null;

  return (
    <div
      className={cn("flex flex-wrap items-center gap-1.5", className)}
      aria-label="Admitted signs"
    >
      {tokens.map((tok, i) => (
        <span
          key={`${tok.label}-${tok.ts}-${i}`}
          title={`via ${tok.via} @ ${tok.score.toFixed(2)}`}
          className={cn(
            "rounded-sc-full border px-2 py-0.5 font-mono text-[11px] tracking-wide whitespace-nowrap",
            tok.via === "stable"
              ? "border-sc-accent-700/40 bg-sc-accent-600 text-sc-text-inverse shadow-sc-xs"
              : "border-sc-accent-300/60 bg-sc-accent-500/15 text-sc-accent-300 backdrop-blur-sm",
          )}
        >
          {tok.label}
        </span>
      ))}
    </div>
  );
}
