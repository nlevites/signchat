"use client";

import {
  ArrowClockwise,
  Check,
  Pencil,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { ReconstructionPayload } from "@signchat/contracts";
import { cn } from "@/lib/cn";

export interface InlinePreviewProps {
  preview: ReconstructionPayload;
  onApprove: (text: string) => void;
  onResign: () => void;
  onDiscard: () => void;
  className?: string;
}

const CONFIDENCE_CHIP: Record<ReconstructionPayload["confidence"], string> = {
  high: "bg-sc-success/15 text-sc-success",
  medium: "bg-sc-warning/15 text-sc-warning",
  low: "bg-sc-danger/15 text-sc-danger",
};

export function InlinePreview({
  preview,
  onApprove,
  onResign,
  onDiscard,
  className,
}: InlinePreviewProps) {
  const reduce = useReducedMotion();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(preview.sentence);

  // Re-seed the buffer when a new payload arrives outside of edit mode.
  // While editing, leave the user's in-progress text alone.
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

  const toggleEdit = () => {
    setEditing((prev) => {
      if (!prev) setEditText(preview.sentence);
      return !prev;
    });
  };

  const motionProps = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : {
        initial: { opacity: 0, y: 8 },
        animate: { opacity: 1, y: 0 },
        exit: { opacity: 0, y: 8 },
      };

  return (
    <motion.div
      {...motionProps}
      transition={{ duration: 0.22, ease: [0.2, 0.8, 0.2, 1] }}
      role="dialog"
      aria-label="Sentence preview"
      className={cn(
        "flex w-full flex-col gap-3 rounded-sc-xl border border-sc-accent-soft-2 bg-sc-surface p-4 shadow-sc-md",
        className,
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="t-meta uppercase text-sc-text-3">Preview</span>
        <span
          className={cn(
            "inline-flex items-center rounded-sc-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            CONFIDENCE_CHIP[preview.confidence],
          )}
        >
          {preview.confidence}
        </span>
        {preview.needsClarification ? (
          <span className="inline-flex items-center rounded-sc-full bg-sc-warning/15 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-sc-warning">
            Needs clarification
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
          className="w-full resize-none rounded-sc-md border border-sc-border-strong bg-sc-surface px-3 py-2 font-mono text-base text-sc-text outline-none transition-[border-color,box-shadow] duration-200 focus-visible:border-sc-accent-500 focus-visible:shadow-[var(--sc-glow-sm)]"
        />
      ) : (
        <p className="t-h2 text-sc-text">{preview.sentence}</p>
      )}

      {preview.usedSigns.length > 0 ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          aria-label="Used signs"
        >
          {preview.usedSigns.map((sign) => (
            <span
              key={sign}
              className="rounded-sc-full bg-sc-accent-soft px-2 py-0.5 font-mono text-[11px] tracking-wide text-sc-accent-700"
            >
              {sign}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <button
          type="button"
          onClick={submit}
          disabled={editing && editText.trim().length === 0}
          className="sc-luminous inline-flex h-9 items-center gap-1.5 rounded-sc-full px-4 t-label transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:pointer-events-none disabled:opacity-40"
        >
          <Check size={16} weight="bold" />
          Approve
        </button>
        <button
          type="button"
          onClick={toggleEdit}
          aria-pressed={editing}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-sc-full border px-4 t-label transition-[border-color,background-color,color,box-shadow,transform] duration-200",
            editing
              ? "border-sc-accent-500 bg-sc-accent-soft text-sc-accent-700"
              : "border-sc-border bg-sc-surface text-sc-text hover:-translate-y-px hover:border-sc-border-strong hover:shadow-sc-sm",
          )}
        >
          <Pencil size={16} weight={editing ? "fill" : "regular"} />
          {editing ? "Cancel edit" : "Edit"}
        </button>
        <button
          type="button"
          onClick={onResign}
          className="inline-flex h-9 items-center gap-1.5 rounded-sc-full border border-sc-warning/30 bg-sc-warning/10 px-4 t-label text-sc-warning transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px hover:border-sc-warning/50 hover:bg-sc-warning/15"
        >
          <ArrowClockwise size={16} weight="bold" />
          Re-sign
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="inline-flex h-9 items-center gap-1.5 rounded-sc-full border border-sc-danger/30 bg-sc-danger/10 px-4 t-label text-sc-danger transition-[background-color,border-color,transform] duration-200 hover:-translate-y-px hover:border-sc-danger/50 hover:bg-sc-danger/15"
        >
          <X size={16} weight="bold" />
          Discard
        </button>
      </div>
    </motion.div>
  );
}
