"use client";

import { useRoomStore } from "@/lib/stores";
import type { ConnectionState } from "@/lib/stores/room";

const LABEL: Record<ConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

const DOT: Record<ConnectionState, string> = {
  idle: "bg-sc-text-3/50",
  connecting: "bg-sc-accent-500 animate-pulse",
  connected: "bg-emerald-500",
  reconnecting: "bg-amber-400 animate-pulse",
  disconnected: "bg-rose-500",
};

export function ConnectionBadge() {
  const state = useRoomStore((s) => s.connectionState);
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-sc-full border border-sc-border bg-sc-surface-2 px-3 py-1 text-[12px] font-medium text-sc-text"
    >
      <span aria-hidden className={`size-2 rounded-full ${DOT[state]}`} />
      {LABEL[state]}
    </span>
  );
}
