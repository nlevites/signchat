"use client";

import type { ReactNode } from "react";
import {
  useModeSnapshot,
} from "@signchat/runtime-browser/mode-controller/controller-store";
import { usePreferencesStore, useDebugSignalsStore } from "@/lib/stores";

/**
 * Live snapshot of the deaf-side mode controller plus the most recent
 * MediaPipe-classifier output — mode, state, buffer tokens, last admit,
 * frame age, and the current top-1 prediction with confidence. Web-live-v1
 * surfaced this as the "capturing · N frames" badge plus the live signs
 * pill row; this is the same data laid out as a debug card.
 */
export function CaptureState() {
  const snapshot = useModeSnapshot();
  const mode = usePreferencesStore((s) => s.mode);
  const result = useDebugSignalsStore((s) => s.latestResult);
  const frame = useDebugSignalsStore((s) => s.latestFrame);

  const top = result?.top?.[0];
  const lastAdmit = snapshot.buffer.lastAdmitAt
    ? `${(performance.now() - snapshot.buffer.lastAdmitAt).toFixed(0)} ms ago`
    : "(none)";
  const frameAge = frame
    ? `${(performance.now() - frame.ts).toFixed(0)} ms ago`
    : "(none)";

  return (
    <div className="flex flex-col gap-3">
      <dl className="flex flex-col gap-1.5 font-mono text-[12px] text-sc-text-2">
        <Row label="mode">{mode}</Row>
        <Row label="state">{snapshot.state}</Row>
        <Row label="buffer">
          {snapshot.buffer.tokens.length === 0
            ? "(empty)"
            : `${snapshot.buffer.tokens.length} token${snapshot.buffer.tokens.length === 1 ? "" : "s"}`}
        </Row>
        <Row label="last admit">{lastAdmit}</Row>
        <Row label="frame age">{frameAge}</Row>
        <Row label="top-1">
          {top ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="text-sc-text">{top.label}</span>
              <span className="text-sc-text-3">
                {(top.score * 100).toFixed(1)}%
              </span>
            </span>
          ) : (
            "(none)"
          )}
        </Row>
      </dl>

      {snapshot.buffer.tokens.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {snapshot.buffer.tokens.map((token, idx) => (
            <span
              key={`${token.label}-${idx}`}
              className="rounded-sc-full bg-sc-accent-soft px-2.5 py-0.5 font-mono text-[11px] font-medium text-sc-accent-700"
              title={`score=${token.score.toFixed(2)} via=${token.via}`}
            >
              {token.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sc-text-3">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-right text-sc-text">
        {children}
      </dd>
    </div>
  );
}
