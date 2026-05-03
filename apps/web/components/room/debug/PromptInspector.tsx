"use client";

import { Check, Copy } from "@phosphor-icons/react/dist/ssr";
import { useState } from "react";
import { cn } from "@/lib/cn";
import {
  useDebugSignalsStore,
  type ReconstructPromptSnapshot,
} from "@/lib/stores";

/**
 * Debug panel that shows the most-recent reconstruct prompt being sent to
 * OpenRouter. Updates the moment <DeafSession>'s stitching effect builds
 * the request, then patches in the latency / parsed payload / token counts
 * once the call settles.
 */
export function PromptInspector() {
  const snap = useDebugSignalsStore((s) => s.lastReconstructPrompt);

  if (!snap) {
    return (
      <p className="t-body-sm text-sc-text-3">
        No reconstruct call yet. Sign a turn and the prompt sent to OpenRouter
        will appear here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <Header snap={snap} />
      <PromptSection
        label="User prompt"
        text={snap.userPrompt}
        defaultOpen
      />
      <PromptSection
        label="System prompt"
        text={snap.systemPrompt}
        defaultOpen={false}
      />
      {snap.status === "ok" && snap.raw ? (
        <PromptSection label="Response (raw JSON)" text={snap.raw} defaultOpen />
      ) : null}
      {snap.status === "error" && snap.errorMessage ? (
        <p className="rounded-sc-md bg-sc-warning-subtle px-3 py-2 t-body-sm text-sc-warning">
          {snap.errorMessage}
        </p>
      ) : null}
    </div>
  );
}

function Header({ snap }: { snap: ReconstructPromptSnapshot }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <StatusPill status={snap.status} />
      <span className="font-mono t-meta text-sc-text-2">{snap.modelId}</span>
      <span className="t-meta text-sc-text-3">
        {new Date(snap.sentAt).toLocaleTimeString()}
      </span>
      {snap.latencyMs !== undefined ? (
        <span className="t-meta text-sc-text-3">
          {Math.round(snap.latencyMs)}ms
        </span>
      ) : null}
      {snap.inputTokens !== undefined || snap.outputTokens !== undefined ? (
        <span className="t-meta text-sc-text-3">
          {snap.inputTokens ?? "?"}→{snap.outputTokens ?? "?"} tok
        </span>
      ) : null}
      {snap.costUsd !== undefined ? (
        <span className="t-meta text-sc-text-3">
          ${snap.costUsd.toFixed(5)}
        </span>
      ) : null}
      {snap.signs.length > 0 ? (
        <span className="t-meta font-mono text-sc-text-3 truncate">
          {snap.signs.join(" · ")}
        </span>
      ) : null}
    </div>
  );
}

function StatusPill({ status }: { status: ReconstructPromptSnapshot["status"] }) {
  const tone =
    status === "pending"
      ? "border-sc-accent-700/40 bg-sc-accent-soft text-sc-accent-700"
      : status === "ok"
        ? "border-sc-success/40 bg-sc-success/10 text-sc-success"
        : "border-sc-danger/40 bg-sc-danger/10 text-sc-danger";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sc-full border px-2.5 py-0.5 t-meta",
        tone,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          status === "pending"
            ? "animate-pulse bg-sc-accent-700"
            : status === "ok"
              ? "bg-sc-success"
              : "bg-sc-danger",
        )}
      />
      {status}
    </span>
  );
}

interface PromptSectionProps {
  label: string;
  text: string;
  defaultOpen: boolean;
}

function PromptSection({ label, text, defaultOpen }: PromptSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <div className="overflow-hidden rounded-sc-md border border-sc-divider bg-sc-surface-2">
      <div className="flex items-center justify-between gap-2 border-b border-sc-divider px-3 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="t-meta uppercase text-sc-text-3 transition-colors duration-150 hover:text-sc-text-2"
        >
          {open ? "▾" : "▸"} {label}
          <span className="ml-2 normal-case text-sc-text-3">
            {text.length} chars
          </span>
        </button>
        <button
          type="button"
          onClick={() => void onCopy()}
          className="inline-flex items-center gap-1 rounded-sc-md px-2 py-0.5 t-meta text-sc-text-3 transition-colors duration-150 hover:bg-sc-surface hover:text-sc-text-2"
          aria-label={`Copy ${label.toLowerCase()}`}
        >
          {copied ? (
            <>
              <Check size={12} weight="bold" />
              copied
            </>
          ) : (
            <>
              <Copy size={12} weight="regular" />
              copy
            </>
          )}
        </button>
      </div>
      {open ? (
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[12px] leading-snug text-sc-text">
          {text || "(empty)"}
        </pre>
      ) : null}
    </div>
  );
}
