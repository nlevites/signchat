"use client";

interface PanePlaceholderProps {
  title: string;
  phase: string;
  summary: string;
  bullets?: readonly string[];
}

export function PanePlaceholder({ title, phase, summary, bullets }: PanePlaceholderProps) {
  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
      <header className="mb-3 flex items-baseline gap-3">
        <h2 className="text-xl font-semibold text-slate-100">{title}</h2>
        <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-amber-300">
          {phase} — placeholder
        </span>
      </header>
      <p className="mb-4 text-sm text-slate-300">{summary}</p>
      {bullets && bullets.length > 0 ? (
        <ul className="space-y-1.5 text-sm text-slate-400">
          {bullets.map((b) => (
            <li key={b} className="flex items-start gap-2">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-slate-500" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
