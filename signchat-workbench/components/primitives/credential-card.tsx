"use client";

import { useState } from "react";

export type CredentialStatus =
  | "idle"
  | "minting"
  | "ok"
  | "failed"
  | "skipped";

interface KeyValueRow {
  label: string;
  /** Plain text shown directly. Safe values only. */
  value?: string;
  /** Sensitive value masked unless "Show" is clicked. */
  sensitiveValue?: string;
}

interface CredentialCardProps {
  title: string;
  /** "GET /api/livekit/token" / "POST /api/openrouter/session-key" — purely cosmetic. */
  endpoint: string;
  status: CredentialStatus;
  /** Last mint latency in ms; ignored when status !== "ok". */
  latencyMs?: number | null;
  /** Error message when status === "failed". */
  errorMessage?: string | null;
  /** Skipped reason when status === "skipped" (e.g. "hearing role"). */
  skippedReason?: string | null;
  /** Rows rendered in the body. Sensitive values are masked by default. */
  rows?: ReadonlyArray<KeyValueRow>;
}

const STATUS_PALETTE: Record<CredentialStatus, string> = {
  idle: "border-slate-600 bg-slate-700/30 text-slate-300",
  minting: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  failed: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  skipped: "border-slate-600 bg-slate-700/30 text-slate-400",
};

const STATUS_LABEL: Record<CredentialStatus, string> = {
  idle: "idle",
  minting: "minting…",
  ok: "ok",
  failed: "failed",
  skipped: "skipped",
};

export function CredentialCard({
  title,
  endpoint,
  status,
  latencyMs,
  errorMessage,
  skippedReason,
  rows,
}: CredentialCardProps) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <header className="mb-3 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">{title}</h3>
          <code className="text-[11px] text-slate-500">{endpoint}</code>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {status === "ok" && typeof latencyMs === "number" ? (
            <span className="font-mono text-[11px] tabular-nums text-slate-400">
              {Math.round(latencyMs)}ms
            </span>
          ) : null}
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${STATUS_PALETTE[status]}`}
          >
            {STATUS_LABEL[status]}
          </span>
        </div>
      </header>
      {status === "failed" && errorMessage ? (
        <div className="mb-3 rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
          {errorMessage}
        </div>
      ) : null}
      {status === "skipped" && skippedReason ? (
        <div className="mb-3 rounded-md border border-slate-600 bg-slate-800/50 p-2 text-xs text-slate-400">
          {skippedReason}
        </div>
      ) : null}
      {rows && rows.length > 0 ? (
        <ul className="space-y-1.5 text-xs">
          {rows.map((row) => (
            <CredentialRow key={row.label} row={row} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function CredentialRow({ row }: { row: KeyValueRow }) {
  const [revealed, setRevealed] = useState(false);
  const isSensitive = typeof row.sensitiveValue === "string";
  const display = isSensitive
    ? revealed
      ? (row.sensitiveValue as string)
      : maskSensitive(row.sensitiveValue as string)
    : row.value ?? "";
  return (
    <li className="flex items-center gap-2">
      <span className="w-28 shrink-0 text-slate-400">{row.label}</span>
      <code className="min-w-0 grow truncate font-mono text-slate-200">
        {display}
      </code>
      {isSensitive ? (
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => setRevealed((v) => !v)}
            className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
          >
            {revealed ? "hide" : "show"}
          </button>
          <button
            type="button"
            onClick={() => {
              if (typeof navigator !== "undefined" && navigator.clipboard) {
                void navigator.clipboard.writeText(row.sensitiveValue as string);
              }
            }}
            className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
          >
            copy
          </button>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Replace the middle of long sensitive strings with "***" so the prefix and
 * suffix remain visible (useful for visual identification) but the secret is
 * not legible. Short values are fully masked.
 */
function maskSensitive(value: string): string {
  if (!value) return "";
  if (value.length <= 12) return "*".repeat(value.length);
  const head = value.slice(0, 6);
  const tail = value.slice(-4);
  return `${head}…${"*".repeat(8)}…${tail}`;
}
