"use client";

import { useMemo, useState } from "react";
import { LogBus, useLogStream, type LogLevel } from "@/lib/diagnostics/log-bus";

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "text-slate-400",
  info: "text-sky-300",
  warn: "text-amber-300",
  error: "text-rose-300",
};

const LEVEL_BG: Record<LogLevel, string> = {
  debug: "bg-slate-700/40",
  info: "bg-sky-700/30",
  warn: "bg-amber-700/30",
  error: "bg-rose-700/30",
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
    const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    return all.filter((e) => {
      if (filterSource && e.source !== filterSource) return false;
      if (order[e.level] < order[minLevel]) return false;
      return true;
    });
  }, [all, filterSource, minLevel]);

  return (
    <div className="fixed bottom-0 left-0 right-0 z-30 border-t border-slate-700 bg-slate-900/95 backdrop-blur">
      <div className="flex items-center gap-3 px-4 py-2 text-xs">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="rounded border border-slate-600 px-2 py-1 text-slate-200 hover:bg-slate-800"
        >
          {open ? "Hide" : "Show"} log ({filtered.length})
        </button>
        <span className="text-slate-500">filter:</span>
        <select
          value={filterSource}
          onChange={(e) => setFilterSource(e.target.value)}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-slate-200"
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
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 text-slate-200"
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
            className="rounded border border-slate-600 px-2 py-1 text-slate-300 hover:bg-slate-800"
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
              a.download = `workbench-log-${Date.now()}.json`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded border border-slate-600 px-2 py-1 text-slate-300 hover:bg-slate-800"
          >
            Export
          </button>
        </span>
      </div>
      {open ? (
        <div className="max-h-64 overflow-y-auto px-4 pb-3 font-mono text-xs">
          {filtered.length === 0 ? (
            <div className="py-6 text-center text-slate-500">no log entries match filters</div>
          ) : (
            <ul className="space-y-1">
              {filtered.slice(-200).map((entry) => (
                <li key={entry.id} className="flex items-start gap-2">
                  <span className="w-20 shrink-0 text-slate-500">
                    {formatTs(entry.ts)}
                  </span>
                  <span
                    className={`w-14 shrink-0 rounded px-1 text-center text-[10px] uppercase ${LEVEL_BG[entry.level]} ${LEVEL_COLOR[entry.level]}`}
                  >
                    {entry.level}
                  </span>
                  <span className="w-24 shrink-0 truncate text-slate-300">{entry.source}</span>
                  <span className="text-slate-100">{entry.message}</span>
                  {entry.payload !== undefined ? (
                    <span className="ml-2 break-all text-slate-500">
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
