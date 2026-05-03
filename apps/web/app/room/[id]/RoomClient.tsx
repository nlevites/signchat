"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import type { Role } from "@signchat/contracts";
import { Logo } from "@/components/ui/Logo";
import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { Lobby, type LobbyDeviceState } from "@/components/room/Lobby";
import { VideoTile } from "@/components/room/VideoTile";
import { ViewToggle, type ViewMode } from "@/components/room/ViewToggle";
import { useRoomStore } from "@/lib/stores";

interface RoomClientProps {
  roomId: string;
}

function parseRole(raw: string | null): Role | null {
  if (raw === "deaf" || raw === "hearing") return raw;
  return null;
}

export function RoomClient({ roomId }: RoomClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = parseRole(searchParams.get("role"));
  const name = searchParams.get("name") ?? "guest";
  const [joined, setJoined] = useState(false);
  const [, setDevices] = useState<LobbyDeviceState | null>(null);

  const setRoomId = useRoomStore((s) => s.setRoomId);
  const setRole = useRoomStore((s) => s.setRole);
  const setName = useRoomStore((s) => s.setName);
  const setConnectionState = useRoomStore((s) => s.setConnectionState);

  useEffect(() => {
    setRoomId(roomId);
    setRole(role);
    setName(name);
    return () => {
      setConnectionState("idle");
    };
  }, [roomId, role, name, setRoomId, setRole, setName, setConnectionState]);

  if (!role) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-sc-bg px-6 py-12">
        <div className="flex flex-col items-center gap-4">
          <p className="t-body text-sc-text-2">Pick a role to enter this room.</p>
          <Link
            href="/start"
            className="sc-luminous inline-flex h-10 items-center rounded-sc-full px-5 t-label"
          >
            Go to start
          </Link>
        </div>
      </main>
    );
  }

  if (!joined) {
    return (
      <Lobby
        roomId={roomId}
        displayName={name}
        role={role}
        onJoin={(d) => {
          setDevices(d);
          setJoined(true);
          setConnectionState("connecting");
        }}
        onCancel={() => router.push("/start")}
      />
    );
  }

  return (
    <ActiveRoom
      roomId={roomId}
      displayName={name}
      role={role}
      onLeave={() => router.push("/")}
    />
  );
}

interface ActiveRoomProps {
  roomId: string;
  displayName: string;
  role: Role;
  onLeave: () => void;
}

function ActiveRoom({ roomId, displayName, role, onLeave }: ActiveRoomProps) {
  const [view, setView] = useState<ViewMode>("production");
  const [chatOpen, setChatOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-sc-bg text-sc-text">
      <header
        className="z-30 flex shrink-0 items-center justify-between gap-3 px-5 py-3 text-white shadow-[0_1px_0_rgba(0,0,0,0.05)]"
        style={{ background: "var(--sc-accent-gradient)" }}
      >
        <div className="flex items-center gap-5">
          <Link
            href="/"
            aria-label="Signchat home"
            className="rounded-sc-md transition-opacity hover:opacity-90"
          >
            <Logo size={48} wordmarkSize={32} surface="overlay" />
          </Link>
          <span className="h-7 w-px bg-white/20" aria-hidden />
          <div className="flex items-center gap-2">
            <span className="t-meta uppercase text-white/65">Room</span>
            <code className="font-mono text-[15px] font-medium text-white">
              {roomId}
            </code>
          </div>
        </div>
        <ViewToggle value={view} onChange={setView} />
      </header>

      <div className="flex min-h-0 flex-1 bg-sc-surface-2">
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pt-6 pb-24">
            <div className="grid h-full max-h-full w-full max-w-[1200px] grid-cols-1 content-center gap-4 md:grid-cols-2">
              <VideoTile label={`${displayName} · you (${role})`} />
              <VideoTile empty />
            </div>

            <ControlBar
              micEnabled={micEnabled}
              camEnabled={camEnabled}
              chatOpen={chatOpen}
              settingsOpen={settingsOpen}
              onToggleMic={() => setMicEnabled((v) => !v)}
              onToggleCam={() => setCamEnabled((v) => !v)}
              onToggleChat={() => setChatOpen((v) => !v)}
              onToggleSettings={() => setSettingsOpen((v) => !v)}
              onLeave={onLeave}
            />
          </div>

          <AnimatePresence>
            {view === "debug" ? (
              <motion.div
                key="debug-panel"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.55, ease: [0.32, 0.72, 0, 1] }}
                className="overflow-hidden border-t border-sc-border bg-sc-surface"
              >
                <div className="max-h-[40vh] overflow-y-auto p-5">
                  <p className="t-body-sm text-sc-text-2">
                    Debug panel placeholder — model picker, latency markers,
                    sign capture overlay land here once the pipeline is wired.
                  </p>
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </section>

        <motion.aside
          className="relative shrink-0 overflow-hidden border-l border-sc-border"
          initial={false}
          animate={{ width: chatOpen ? 360 : 0 }}
          transition={{ duration: 0.52, ease: [0.32, 0.72, 0, 1] }}
        >
          <div className="absolute inset-y-0 right-0 flex w-[360px] flex-col">
            <ChatPanel identity={displayName} />
          </div>
        </motion.aside>
      </div>
    </main>
  );
}
