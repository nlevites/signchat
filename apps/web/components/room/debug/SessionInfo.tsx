"use client";

import type { ReactNode } from "react";
import { useRoomStore } from "@/lib/stores";

/**
 * Read-only summary of the live LiveKit session — connection state, room
 * id, identity, role, and the remote participant if one has joined.
 * Mirrors web-live-v1's debug-overlay "Session" card.
 */
export function SessionInfo() {
  const roomId = useRoomStore((s) => s.roomId);
  const identity = useRoomStore((s) => s.identity);
  const name = useRoomStore((s) => s.name);
  const role = useRoomStore((s) => s.role);
  const connectionState = useRoomStore((s) => s.connectionState);
  const remote = useRoomStore((s) => s.remoteParticipant);

  return (
    <dl className="flex flex-col gap-1.5 font-mono text-[12px] text-sc-text-2">
      <Row label="connection">{String(connectionState)}</Row>
      <Row label="room">{roomId ?? "(none)"}</Row>
      <Row label="identity">{identity ?? "(none)"}</Row>
      <Row label="name">{name ?? "(none)"}</Row>
      <Row label="role">{role ?? "(none)"}</Row>
      <Row label="remote">
        {remote
          ? `${remote.name ?? "?"}${remote.role ? ` · ${remote.role}` : ""}`
          : "(waiting)"}
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-sc-text-3">{label}</dt>
      <dd className="truncate text-sc-text">{children}</dd>
    </div>
  );
}
