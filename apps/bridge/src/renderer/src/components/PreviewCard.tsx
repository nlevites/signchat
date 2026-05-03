import { useEffect, useState, type JSX } from "react";
import type { ReconstructionPayload } from "@signchat/contracts";
import { cn } from "../lib/cn";

export interface PreviewCardProps {
  preview: ReconstructionPayload;
  onApprove(text: string): void;
  onResign(): void;
  onDiscard(): void;
}

const CONFIDENCE_CHIP: Record<ReconstructionPayload["confidence"], string> = {
  high: "bg-emerald-500/15 text-emerald-300",
  medium: "bg-amber-500/15 text-amber-300",
  low: "bg-rose-500/15 text-rose-300",
};

export function PreviewCard({
  preview,
  onApprove,
  onResign,
  onDiscard,
}: PreviewCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(preview.sentence);

  useEffect(() => {
    if (!editing) setEditText(preview.sentence);
  }, [preview.sentence, editing]);

  const submit = () => {
    if (editing) {
      const trimmed = editText.trim();
      if (!trimmed) return;
      onApprove(trimmed);
      return;
    }
    onApprove(preview.sentence);
  };

  return (
    <div
      role="dialog"
      aria-label="Sentence preview"
      className="space-y-3 rounded-lg border border-indigo-700/40 bg-zinc-900 p-3 shadow-lg"
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          Preview
        </span>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            CONFIDENCE_CHIP[preview.confidence],
          )}
        >
          {preview.confidence}
        </span>
        {preview.needsClarification ? (
          <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
            needs clarification
          </span>
        ) : null}
      </header>

      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => setEditText(e.target.value)}
          rows={2}
          autoFocus
          aria-label="Edit sentence"
          className="w-full resize-none rounded border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-indigo-500"
        />
      ) : (
        <p className="text-base font-medium text-zinc-100">{preview.sentence}</p>
      )}

      {preview.usedSigns.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {preview.usedSigns.map((sign) => (
            <span
              key={sign}
              className="rounded-full bg-zinc-800 px-2 py-0.5 font-mono text-[10px] tracking-wide text-zinc-300"
            >
              {sign}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={editing && editText.trim().length === 0}
          className="rounded-md bg-indigo-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Approve & speak
        </button>
        <button
          type="button"
          onClick={() => setEditing((p) => !p)}
          aria-pressed={editing}
          className={cn(
            "rounded-md border px-3 py-1.5 text-xs font-semibold",
            editing
              ? "border-indigo-500 bg-indigo-500/15 text-indigo-200"
              : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:bg-zinc-800",
          )}
        >
          {editing ? "Cancel edit" : "Edit"}
        </button>
        <button
          type="button"
          onClick={onResign}
          className="rounded-md border border-amber-700/50 bg-amber-900/20 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/30"
        >
          Re-sign
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md border border-rose-700/50 bg-rose-900/20 px-3 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-900/30"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
