"use client";

import { cn } from "@/lib/cn";
import { useLatencyStats } from "@/lib/diagnostics/latency-markers";

interface LatencyRow {
  stage: string;
  label: string;
  /** §13 budget (p50, p95) in ms; null when no formal budget. */
  budgetP50: number | null;
  budgetP95: number | null;
}

const LATENCY_ROWS: ReadonlyArray<LatencyRow> = [
  {
    stage: "openrouter.reconstruct",
    label: "OpenRouter reconstruct",
    budgetP50: 600,
    budgetP95: 1200,
  },
  {
    stage: "tts.wss.open",
    label: "TTS WSS open",
    budgetP50: null,
    budgetP95: null,
  },
  {
    stage: "tts.firstByte",
    label: "TTS first byte",
    budgetP50: 150,
    budgetP95: 350,
  },
  {
    stage: "tts.firstAudible",
    label: "TTS first audible",
    budgetP50: null,
    budgetP95: null,
  },
  {
    stage: "tts.turnEnd",
    label: "TTS turn end",
    budgetP50: null,
    budgetP95: null,
  },
  {
    stage: "e2e.turn",
    label: "E2E sign-end → first audible",
    budgetP50: 950,
    budgetP95: 1600,
  },
  {
    stage: "whisper.first-partial",
    label: "Whisper first partial",
    budgetP50: null,
    budgetP95: null,
  },
  {
    stage: "whisper.partial",
    label: "Whisper partial",
    budgetP50: null,
    budgetP95: null,
  },
];

export function LatencyTable() {
  return (
    <div className="rounded-sc-xl border border-sc-border bg-sc-surface p-4 shadow-sc-xs">
      <h3 className="mb-3 t-h3 text-sc-text">Latency (vs §13 budgets)</h3>
      <table className="w-full t-body-sm">
        <thead>
          <tr className="border-b border-sc-divider t-meta uppercase text-sc-text-3">
            <th className="py-2 text-left font-medium">stage</th>
            <th className="py-2 text-right font-medium">last</th>
            <th className="py-2 text-right font-medium">p50</th>
            <th className="py-2 text-right font-medium">p95</th>
            <th className="py-2 text-right font-medium">budget p50/p95</th>
          </tr>
        </thead>
        <tbody>
          {LATENCY_ROWS.map((row) => (
            <LatencyTableRow key={row.stage} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LatencyTableRow({ row }: { row: LatencyRow }) {
  const stats = useLatencyStats(row.stage);
  const last = stats?.last ?? null;
  const p50 = stats?.p50 ?? null;
  const p95 = stats?.p95 ?? null;
  const overP50 =
    row.budgetP50 !== null && p50 !== null && p50 > row.budgetP50;
  const overP95 =
    row.budgetP95 !== null && p95 !== null && p95 > row.budgetP95;
  const overBudget = overP50 || overP95;
  return (
    <tr
      className={cn(
        "border-b border-sc-divider last:border-b-0",
        overBudget && "bg-sc-danger/5",
      )}
    >
      <td className="py-1.5 font-mono text-[12px] text-sc-text">{row.stage}</td>
      <td className="py-1.5 text-right tabular-nums text-sc-text-2">
        {last !== null ? `${Math.round(last)}ms` : "—"}
      </td>
      <td
        className={cn(
          "py-1.5 text-right tabular-nums",
          overP50 ? "font-medium text-sc-danger" : "text-sc-text",
        )}
      >
        {p50 !== null ? `${Math.round(p50)}ms` : "—"}
      </td>
      <td
        className={cn(
          "py-1.5 text-right tabular-nums",
          overP95 ? "font-medium text-sc-danger" : "text-sc-text",
        )}
      >
        {p95 !== null ? `${Math.round(p95)}ms` : "—"}
      </td>
      <td className="py-1.5 text-right tabular-nums text-sc-text-3">
        {row.budgetP50 !== null && row.budgetP95 !== null
          ? `${row.budgetP50} / ${row.budgetP95}ms`
          : "—"}
      </td>
    </tr>
  );
}
