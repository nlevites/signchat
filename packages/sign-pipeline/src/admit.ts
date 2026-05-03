import type { SignBuffer, SignToken } from "@signchat/contracts";

export const STABILITY_TICKS = 2;

export interface AdmitThresholds {
  top1Threshold: number;
  top2Threshold: number;
}

export interface Candidate {
  label: string;
  score: number;
}

export function admitToken(
  buffer: SignBuffer,
  top1: Candidate,
  top2: Candidate,
  thresholds: AdmitThresholds,
  prevTopLabel: string | null,
): SignBuffer {
  const lastAdmitted = buffer.tokens[buffer.tokens.length - 1];

  let via: SignToken["via"] | null = null;
  if (top1.score >= thresholds.top1Threshold && top1.label === prevTopLabel) {
    via = "stable";
  } else if (
    top1.score >= thresholds.top2Threshold &&
    top1.score < thresholds.top1Threshold &&
    top2.score >= thresholds.top2Threshold &&
    top1.label !== lastAdmitted?.label
  ) {
    via = "band";
  }

  if (via === null) return buffer;

  const ts = performance.now();
  const next: SignToken = { label: top1.label, score: top1.score, ts, via };
  return {
    ...buffer,
    tokens: [...buffer.tokens, next],
    lastAdmitAt: ts,
  };
}
