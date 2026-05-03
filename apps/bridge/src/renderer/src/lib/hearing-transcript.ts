import { useSyncExternalStore } from "react";

/**
 * Tiny rolling transcript shared between the STT pipeline (Hearing user
 * partials/finals), the speaking pipeline (the user's own approved
 * sentences), and the LLM call (`recentDialog` context).
 *
 * Mirrors the shape `buildReconstructionRequest` in `@signchat/prompts`
 * consumes — newline-delimited lines tagged "You said:" for the signer
 * and "They said:" for the Hearing user. DeafSession in apps/web builds
 * the same string from its Zustand transcript store; Bridge has no other
 * persistence requirement, so we keep this self-contained.
 *
 * Capacity is small (~8 finals each direction) — the prompt template only
 * uses the most recent context, and we don't want to bloat the LLM input
 * tokens for long sessions.
 */

const MAX_FINALS_PER_SIDE = 8;

interface DialogLine {
  side: "hearing" | "self";
  text: string;
  ts: number;
}

interface TranscriptState {
  hearing: DialogLine[];
  self: DialogLine[];
  latestPartial: string | null;
}

const EMPTY_STATE: TranscriptState = {
  hearing: [],
  self: [],
  latestPartial: null,
};

class HearingTranscriptStore {
  private state: TranscriptState = EMPTY_STATE;
  private subs = new Set<() => void>();

  appendHearingFinal(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next: DialogLine = { side: "hearing", text: trimmed, ts: Date.now() };
    const hearing = appendBounded(this.state.hearing, next);
    this.state = {
      ...this.state,
      hearing,
      latestPartial: null,
    };
    this.notify();
  }

  appendSelfFinal(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    const next: DialogLine = { side: "self", text: trimmed, ts: Date.now() };
    const self = appendBounded(this.state.self, next);
    this.state = {
      ...this.state,
      self,
    };
    this.notify();
  }

  setLatestPartial(text: string | null): void {
    const value = text === null ? null : text.trim() || null;
    if (this.state.latestPartial === value) return;
    this.state = { ...this.state, latestPartial: value };
    this.notify();
  }

  /**
   * Newline-delimited "You said: ..." / "They said: ..." lines, oldest
   * first. Bounded to the most recent `MAX_FINALS_PER_SIDE * 2` lines so
   * the prompt's context block stays compact.
   *
   * Stable across non-mutating renders: returns "" when both buffers are
   * empty; otherwise rebuilds from the current snapshot.
   */
  recentDialog(): string {
    const merged: DialogLine[] = [...this.state.hearing, ...this.state.self];
    merged.sort((a, b) => a.ts - b.ts);
    if (merged.length === 0) return "";
    const lines = merged.map((line) =>
      line.side === "self"
        ? `You said: ${line.text}`
        : `They said: ${line.text}`,
    );
    return lines.join("\n");
  }

  snapshot(): TranscriptState {
    return this.state;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  reset(): void {
    this.state = EMPTY_STATE;
    this.notify();
  }

  private notify(): void {
    for (const cb of this.subs) {
      try {
        cb();
      } catch {
        // ignore subscriber faults
      }
    }
  }
}

function appendBounded(
  list: ReadonlyArray<DialogLine>,
  next: DialogLine,
): DialogLine[] {
  const merged = [...list, next];
  if (merged.length <= MAX_FINALS_PER_SIDE) return merged;
  return merged.slice(merged.length - MAX_FINALS_PER_SIDE);
}

export const HearingTranscript = new HearingTranscriptStore();

const subscribeTranscript = (cb: () => void) =>
  HearingTranscript.subscribe(cb);
const getTranscriptSnapshot = () => HearingTranscript.snapshot();

export function useHearingTranscript(): TranscriptState {
  return useSyncExternalStore(
    subscribeTranscript,
    getTranscriptSnapshot,
    getTranscriptSnapshot,
  );
}
