"use client";

import { useMemo, useSyncExternalStore } from "react";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** Monotonic id, assigned by the bus. */
  id: number;
  /** Wall-clock ms at emit. */
  ts: number;
  /** Source module, e.g. "livekit", "openrouter", "elevenlabs", "audio", "sign". */
  source: string;
  level: LogLevel;
  message: string;
  /** Optional structured payload. JSON-serializable. */
  payload?: unknown;
}

type EntrySubscriber = (entry: LogEntry) => void;
type ChangeSubscriber = () => void;

const RING_SIZE = 1000;
const EMPTY_SNAPSHOT: readonly LogEntry[] = [];

class LogBusImpl {
  private nextId = 1;
  private ring: LogEntry[] = [];
  /** Cached so useSyncExternalStore sees stable identity between emits. */
  private cachedSnapshot: readonly LogEntry[] = EMPTY_SNAPSHOT;
  private entrySubs = new Set<EntrySubscriber>();
  private changeSubs = new Set<ChangeSubscriber>();

  emit(source: string, level: LogLevel, message: string, payload?: unknown): void {
    const entry: LogEntry = {
      id: this.nextId++,
      ts: Date.now(),
      source,
      level,
      message,
      ...(payload !== undefined ? { payload } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    this.cachedSnapshot = this.ring.slice();
    for (const sub of this.entrySubs) {
      try {
        sub(entry);
      } catch {
        // never let a subscriber throw out of emit
      }
    }
    for (const sub of this.changeSubs) {
      try {
        sub();
      } catch {
        // ditto
      }
    }
    if (typeof console !== "undefined") {
      const fn =
        level === "error"
          ? console.error
          : level === "warn"
          ? console.warn
          : level === "debug"
          ? console.debug
          : console.info;
      fn.call(console, `[${source}] ${message}`, payload ?? "");
    }
  }

  debug(source: string, message: string, payload?: unknown): void {
    this.emit(source, "debug", message, payload);
  }
  info(source: string, message: string, payload?: unknown): void {
    this.emit(source, "info", message, payload);
  }
  warn(source: string, message: string, payload?: unknown): void {
    this.emit(source, "warn", message, payload);
  }
  error(source: string, message: string, payload?: unknown): void {
    this.emit(source, "error", message, payload);
  }

  snapshot(): readonly LogEntry[] {
    return this.cachedSnapshot;
  }

  clear(): void {
    this.ring = [];
    this.cachedSnapshot = EMPTY_SNAPSHOT;
    for (const sub of this.changeSubs) {
      try {
        sub();
      } catch {
        // ignore
      }
    }
  }

  /** Per-entry callback (kept for the rare consumer that needs the new entry). */
  onEntry(cb: EntrySubscriber): () => void {
    this.entrySubs.add(cb);
    return () => {
      this.entrySubs.delete(cb);
    };
  }

  /**
   * Change subscription compatible with React's useSyncExternalStore.
   * Fires on any state change (emit OR clear) with no arguments.
   */
  subscribe(cb: ChangeSubscriber): () => void {
    this.changeSubs.add(cb);
    return () => {
      this.changeSubs.delete(cb);
    };
  }
}

export const LogBus = new LogBusImpl();

const subscribeLog = (cb: ChangeSubscriber) => LogBus.subscribe(cb);
const getLogSnapshot = () => LogBus.snapshot();
const getServerLogSnapshot = () => EMPTY_SNAPSHOT;

/**
 * React hook returning the live tail of the log ring, oldest-first.
 * Optional `filter` narrows by source and/or minimum level.
 */
export function useLogStream(filter?: { source?: string; level?: LogLevel }): LogEntry[] {
  const all = useSyncExternalStore(subscribeLog, getLogSnapshot, getServerLogSnapshot);
  const filterSource = filter?.source;
  const filterLevel = filter?.level;
  return useMemo(
    () => applyFilter(all, filterSource, filterLevel),
    [all, filterSource, filterLevel],
  );
}

function applyFilter(
  all: readonly LogEntry[],
  source: string | undefined,
  level: LogLevel | undefined,
): LogEntry[] {
  if (!source && !level) return all.slice();
  return all.filter((e) => {
    if (source && e.source !== source) return false;
    if (level && e.level !== level) return false;
    return true;
  });
}
