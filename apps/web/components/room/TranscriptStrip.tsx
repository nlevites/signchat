"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RoomDataMessage } from "@signchat/contracts";
import { cn } from "@/lib/cn";
import { useTranscriptStore } from "@/lib/stores";

// captions on the speaker tile stay pinned for the TTS playback window
// (~8s per ARCHITECTURE §6.2). only after that window do they migrate into
// the global transcript strip — this avoids double-display alongside the
// per-tile overlay.
const CAPTION_MATURE_MS = 8000;

type EntryKind = "said" | "signed" | "chat";

interface VisibleEntry {
  id: string;
  ts: number;
  kind: EntryKind;
  speaker: string;
  text: string;
}

function pickEntries(
  messages: ReadonlyArray<RoomDataMessage>,
  now: number,
): VisibleEntry[] {
  const out: VisibleEntry[] = [];
  for (const m of messages) {
    switch (m.kind) {
      case "transcript_final":
        out.push({
          id: m.id,
          ts: m.ts,
          kind: "said",
          speaker: m.from.name,
          text: m.text,
        });
        break;
      case "chat":
        out.push({
          id: m.id,
          ts: m.ts,
          kind: "chat",
          speaker: m.from.name,
          text: m.text,
        });
        break;
      case "caption":
        if (now > m.playAtMs + CAPTION_MATURE_MS) {
          out.push({
            id: m.id,
            ts: m.ts,
            kind: "signed",
            speaker: m.from.name,
            text: m.sentence,
          });
        }
        break;
      case "transcript_partial":
        break;
      default: {
        const _exhaustive: never = m;
        void _exhaustive;
      }
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function entryConnector(kind: EntryKind): string {
  switch (kind) {
    case "said":
      return " said: ";
    case "signed":
      return " signed: ";
    case "chat":
      return ": ";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function TranscriptStrip() {
  const messages = useTranscriptStore((s) => s.messages);
  const [now, setNow] = useState<number>(() => Date.now());

  // re-evaluate when the next pending caption matures so it can move into
  // the strip without waiting for an unrelated store update to arrive.
  useEffect(() => {
    const t = Date.now();
    let earliest = Number.POSITIVE_INFINITY;
    for (const m of messages) {
      if (m.kind !== "caption") continue;
      const matureAt = m.playAtMs + CAPTION_MATURE_MS;
      if (matureAt > t && matureAt < earliest) earliest = matureAt;
    }
    if (!Number.isFinite(earliest)) return;
    const id = window.setTimeout(
      () => setNow(Date.now()),
      Math.max(0, earliest - t) + 50,
    );
    return () => window.clearTimeout(id);
  }, [messages, now]);

  const entries = useMemo(() => pickEntries(messages, now), [messages, now]);

  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="polite"
      aria-label="Conversation transcript"
      className="max-h-[140px] shrink-0 overflow-y-auto border-t border-sc-border bg-sc-surface px-5 py-2"
    >
      {entries.length === 0 ? (
        <p className="t-body-sm text-sc-text-3">
          Conversation transcript appears here.
        </p>
      ) : (
        <ul className="flex flex-col gap-1">
          {entries.map((e) => (
            <li
              key={`${e.kind}-${e.id}`}
              className="flex items-baseline gap-2 leading-snug"
            >
              <span className="font-mono text-[11px] text-sc-text-3 tabular-nums">
                [{formatClock(e.ts)}]
              </span>
              <span
                className={cn(
                  "shrink-0 rounded-sc-xs px-1.5 py-px font-mono text-[10px] uppercase tracking-wide",
                  e.kind === "said" &&
                    "bg-sc-accent-soft text-sc-accent-700",
                  e.kind === "signed" &&
                    "bg-sc-accent-soft-2 text-sc-accent-800",
                  e.kind === "chat" && "bg-sc-surface-2 text-sc-text-2",
                )}
              >
                {e.kind}
              </span>
              <span className="t-body-sm min-w-0 break-words text-sc-text">
                <span className="font-medium">{e.speaker}</span>
                <span className="text-sc-text-2">{entryConnector(e.kind)}</span>
                {e.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
