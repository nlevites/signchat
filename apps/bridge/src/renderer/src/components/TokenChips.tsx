import type { JSX } from "react";
import type { SignToken } from "@signchat/contracts";

export interface TokenChipsProps {
  tokens: ReadonlyArray<SignToken>;
}

export function TokenChips({ tokens }: TokenChipsProps): JSX.Element {
  if (tokens.length === 0) {
    return (
      <p className="text-xs text-zinc-500">
        Sign something — admitted tokens appear here.
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {tokens.map((tok, idx) => (
        <span
          key={`${tok.label}-${idx}-${tok.ts}`}
          className="rounded-full bg-indigo-500/20 px-2 py-0.5 font-mono text-[11px] tracking-wide text-indigo-200"
          title={`${tok.via} admit · ${(tok.score * 100).toFixed(0)}%`}
        >
          {tok.label}
        </span>
      ))}
    </div>
  );
}
