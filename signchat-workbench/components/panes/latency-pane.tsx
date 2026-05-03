"use client";

import { useAllStages, useLatencyStats, LatencyStore } from "@/lib/diagnostics/latency-markers";

export function LatencyPane() {
  const stages = useAllStages();

  return (
    <section className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
      <header className="mb-3 flex items-baseline justify-between">
        <div className="flex items-baseline gap-3">
          <h2 className="text-xl font-semibold text-slate-100">Latency dashboard</h2>
          <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-sky-300">
            live
          </span>
        </div>
        <button
          type="button"
          onClick={() => LatencyStore.reset()}
          className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
        >
          Reset
        </button>
      </header>
      <p className="mb-4 text-sm text-slate-400">
        Rolling p50 / p95 per stage from the last 200 samples. Compared against
        the §13 budgets where applicable. Empty until the other panes start
        marking stages.
      </p>
      {stages.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-sm text-slate-500">
          No latency samples yet. Trigger a turn from another pane to populate.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="border-b border-slate-700 text-left text-xs uppercase tracking-wide text-slate-400">
            <tr>
              <th className="py-2 font-medium">Stage</th>
              <th className="py-2 text-right font-medium">Count</th>
              <th className="py-2 text-right font-medium">Last</th>
              <th className="py-2 text-right font-medium">p50</th>
              <th className="py-2 text-right font-medium">p95</th>
            </tr>
          </thead>
          <tbody>
            {stages.map((stage) => (
              <StageRow key={stage} stage={stage} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function StageRow({ stage }: { stage: string }) {
  const stats = useLatencyStats(stage);
  if (!stats) return null;
  return (
    <tr className="border-b border-slate-800">
      <td className="py-2 font-mono text-slate-200">{stage}</td>
      <td className="py-2 text-right tabular-nums text-slate-400">{stats.count}</td>
      <td className="py-2 text-right tabular-nums text-slate-300">
        {Math.round(stats.last)}ms
      </td>
      <td className="py-2 text-right tabular-nums text-slate-100">
        {Math.round(stats.p50)}ms
      </td>
      <td className="py-2 text-right tabular-nums text-slate-100">
        {Math.round(stats.p95)}ms
      </td>
    </tr>
  );
}
