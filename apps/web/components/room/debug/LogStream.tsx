"use client";

import { useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { LogBus, useLogStream, type LogLevel } from "@/lib/diagnostics/log-bus";

const LEVEL_TEXT: Record<LogLevel, string> = {
  debug: "text-sc-text-3",
  info: "text-sc-accent-700",
  warn: "text-sc-warning",
  error: "text-sc-danger",
};

const LEVEL_CHIP: Record<LogLevel, string> = {
  debug: "bg-sc-surface-2 text-sc-text-3",
  info: "bg-sc-accent-soft text-sc-accent-700",
  warn: "bg-sc-warning/15 text-sc-warning",
  error: "bg-sc-danger/15 text-sc-danger",
};

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export function LogStream() {
  const [open, setOpen] = useState(true);
  const [filterSource, setFilterSource] = useState<string>("");
  const [minLevel, setMinLevel] = useState<LogLevel>("debug");

  const all = useLogStream();
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const e of all) set.add(e.source);
    return Array.from(set).sort();
  }, [all]);

  const filtered = useMemo(() => {
    return all.filter((e) => {
      if (filterSource && e.source !== filterSource) return false;
      if (LEVEL_ORDER[e.level] < LEVEL_ORDER[minLevel]) return false;
      return true;
    });
  }, [all, filterSource, minLevel]);

  return (
    <div className="relative z-10 w-full border-t border-sc-border bg-sc-surface/95 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 t-body-sm">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-8 items-center rounded-sc-full border border-sc-border bg-sc-surface px-3 t-label text-sc-text transition-[border-color,background-color] duration-150 hover:border-sc-border-strong hover:bg-sc-surface-2"
        >
          {open ? "Hide" : "Show"} log ({filtered.length})
        </button>
        <span className="t-meta uppercase text-sc-text-3">filter</span>
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          aria-label="Filter by source"
          className="h-8 rounded-sc-md border border-sc-border bg-sc-surface px-2 t-body-sm text-sc-text focus:border-sc-border-strong"
        >
          <option value="">all sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <select
          value={minLevel}
          onChange={(e) => setMinLevel(e.target.value as LogLevel)}
          aria-label="Minimum log level"
          className="h-8 rounded-sc-md border border-sc-border bg-sc-surface px-2 t-body-sm text-sc-text focus:border-sc-border-strong"
        >
          <option value="debug">debug+</option>
          <option value="info">info+</option>
          <option value="warn">warn+</option>
          <option value="error">error</option>
        </select>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              LogBus.clear();
            }}
            className="inline-flex h-8 items-center rounded-sc-full border border-sc-border bg-sc-surface px-3 t-label text-sc-text-2 transition-[border-color,background-color] duration-150 hover:border-sc-border-strong hover:bg-sc-surface-2"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => {
              const blob = new Blob([JSON.stringify(filtered, null, 2)], {
                type: "application/json",
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `signchat-log-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="inline-flex h-8 items-center rounded-sc-full border border-sc-border bg-sc-surface px-3 t-label text-sc-text-2 transition-[border-color,background-color] duration-150 hover:border-sc-border-strong hover:bg-sc-surface-2"
          >
            Export
          </button>
        </span>
      </div>
      {open ? (
        <div className="max-h-64 overflow-y-auto border-t border-sc-divider bg-sc-surface-2 px-4 py-2 font-mono text-[11px]">
          {filtered.length === 0 ? (
            <div className="py-6 text-center t-body-sm text-sc-text-3">
              no log entries match filters
            </div>
          ) : (
            <ul className="space-y-1">
              {filtered.slice(-200).map((entry) => (
                <li key={entry.id} className="flex items-start gap-2">
                  <span className="w-20 shrink-0 text-sc-text-3">
                    {formatTs(entry.ts)}
                  </span>
                  <span
                    className={cn(
                      "w-14 shrink-0 rounded-sc-xs px-1 text-center text-[10px] uppercase",
                      LEVEL_CHIP[entry.level],
                    )}
                  >
                    {entry.level}
                  </span>
                  <span className="w-24 shrink-0 truncate text-sc-text-2">
                    {entry.source}
                  </span>
                  <span className={cn("flex-1", LEVEL_TEXT[entry.level])}>
                    {entry.message}
                  </span>
                  {entry.payload !== undefined ? (
                    <span className="ml-2 break-all text-sc-text-3">
                      {safeStringify(entry.payload)}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function formatTs(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  const milli = String(d.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${milli}`;
}

function safeStringify(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(value);
  }
}
