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
  idle: "bg-white/40",
  connecting: "bg-white/70 animate-pulse",
  connected: "bg-emerald-300",
  reconnecting: "bg-amber-300 animate-pulse",
  disconnected: "bg-rose-400",
};

export function ConnectionBadge() {
  const state = useRoomStore((s) => s.connectionState);
  return (
    <span
      role="status"
      aria-live="polite"
      className="inline-flex items-center gap-2 rounded-sc-full bg-white/10 px-3 py-1 text-[12px] font-medium text-white/90"
    >
      <span aria-hidden className={`size-2 rounded-full ${DOT[state]}`} />
      {LABEL[state]}
    </span>
  );
}
