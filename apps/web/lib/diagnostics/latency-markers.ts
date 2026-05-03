"use client";

import { useSyncExternalStore } from "react";
import { LogBus } from "./log-bus";

/**
 * Per-stage latency markers and rolling p50/p95.
 *
 * Usage:
 *   const turnId = newTurnId();
 *   mark("openrouter.req", turnId, "start");
 *   ...
 *   mark("openrouter.req", turnId, "end");  // emits a duration sample
 */

export interface LatencySample {
  stage: string;
  turnId: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
}

export interface LatencyStats {
  count: number;
  p50: number;
  p95: number;
  last: number;
}

interface PendingStart {
  startedAt: number;
}

const RING_PER_STAGE = 200;
const EMPTY_SAMPLES: readonly LatencySample[] = [];
const EMPTY_STAGES: readonly string[] = [];

class LatencyStoreImpl {
  private pending = new Map<string, PendingStart>();
  private samplesByStage = new Map<string, LatencySample[]>();
  /** Stable snapshots to satisfy useSyncExternalStore identity rules. */
  private cachedStages: readonly string[] = EMPTY_STAGES;
  private cachedStatsByStage = new Map<string, LatencyStats | null>();
  private cachedSamplesByStage = new Map<string, readonly LatencySample[]>();
  private subs = new Set<() => void>();

  mark(stage: string, turnId: string, edge: "start" | "end"): void {
    const key = `${stage}::${turnId}`;
    const now = performance.now();
    if (edge === "start") {
      this.pending.set(key, { startedAt: now });
      return;
    }
    const startEntry = this.pending.get(key);
    if (!startEntry) {
      LogBus.warn(
        "latency",
        `mark(${stage},${turnId},end) without matching start; ignored`,
      );
      return;
    }
    this.pending.delete(key);
    const sample: LatencySample = {
      stage,
      turnId,
      startedAt: startEntry.startedAt,
      endedAt: now,
      durationMs: now - startEntry.startedAt,
    };
    const ring = this.samplesByStage.get(stage) ?? [];
    ring.push(sample);
    if (ring.length > RING_PER_STAGE) ring.shift();
    this.samplesByStage.set(stage, ring);
    this.refreshCaches(stage);
    LogBus.debug("latency", `${stage} +${Math.round(sample.durationMs)}ms`, {
      turnId,
    });
    this.notify();
  }

  samples(stage: string): readonly LatencySample[] {
    return this.cachedSamplesByStage.get(stage) ?? EMPTY_SAMPLES;
  }

  stages(): readonly string[] {
    return this.cachedStages;
  }

  stats(stage: string): LatencyStats | null {
    return this.cachedStatsByStage.get(stage) ?? null;
  }

  reset(): void {
    this.pending.clear();
    this.samplesByStage.clear();
    this.cachedStages = EMPTY_STAGES;
    this.cachedStatsByStage.clear();
    this.cachedSamplesByStage.clear();
    this.notify();
  }

  subscribe(sub: () => void): () => void {
    this.subs.add(sub);
    return () => {
      this.subs.delete(sub);
    };
  }

  private refreshCaches(touchedStage: string): void {
    const ring = this.samplesByStage.get(touchedStage) ?? [];
    this.cachedSamplesByStage.set(touchedStage, ring.slice());
    this.cachedStatsByStage.set(touchedStage, computeStats(ring));
    this.cachedStages = Array.from(this.samplesByStage.keys()).sort();
  }

  private notify(): void {
    for (const sub of this.subs) {
      try {
        sub();
      } catch {
        // ignore
      }
    }
  }
}

function computeStats(ring: readonly LatencySample[]): LatencyStats | null {
  if (ring.length === 0) return null;
  const sorted = ring.map((s) => s.durationMs).sort((a, b) => a - b);
  const lastSample = ring[ring.length - 1];
  return {
    count: ring.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    last: lastSample ? lastSample.durationMs : 0,
  };
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) {
    const only = sortedAsc[0];
    return only ?? 0;
  }
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor(p * (sortedAsc.length - 1))),
  );
  return sortedAsc[idx] ?? 0;
}

export const LatencyStore = new LatencyStoreImpl();

/** Convenience wrapper. */
export function mark(
  stage: string,
  turnId: string,
  edge: "start" | "end",
): void {
  LatencyStore.mark(stage, turnId, edge);
}

/** Stable id for one logical "turn" through the system. */
export function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

const subscribeLatency = (cb: () => void) => LatencyStore.subscribe(cb);
const getServerEmptyStats = () => null;
const getServerEmptyStages = () => EMPTY_STAGES;

export function useLatencyStats(stage: string): LatencyStats | null {
  return useSyncExternalStore(
    subscribeLatency,
    () => LatencyStore.stats(stage),
    getServerEmptyStats,
  );
}

export function useAllStages(): readonly string[] {
  return useSyncExternalStore(
    subscribeLatency,
    () => LatencyStore.stages(),
    getServerEmptyStages,
  );
}
