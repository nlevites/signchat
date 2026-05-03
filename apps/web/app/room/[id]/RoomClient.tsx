"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Role } from "@signchat/contracts";
import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { Lobby, type LobbyDeviceState } from "@/components/room/Lobby";
import { RoomSettingsDialog } from "@/components/room/RoomSettingsDialog";
import { VideoTile } from "@/components/room/VideoTile";
import type { ViewMode } from "@/components/room/ViewToggle";
import { useDevWindowHandle } from "@/lib/dev-window";
import { mintLiveKitToken } from "@/lib/livekit/mint-token";
import { useLiveKitRoom } from "@/lib/livekit/room";
import { useRoomStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

interface RoomClientProps {
  roomId: string;
}

function parseRole(raw: string | null): Role | null {
  if (raw === "deaf" || raw === "hearing") return raw;
  return null;
}

// identity must satisfy the api's id regex: [a-zA-Z0-9_\-\s]{1,64}.
// uuid v4 is 36 chars, only hex + dashes — passes. one per browser context so
// two windows on the same name don't collide as the same livekit participant.
function makeIdentity(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function RoomClient({ roomId }: RoomClientProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const role = parseRole(searchParams.get("role"));
  const name = searchParams.get("name") ?? "guest";
  const identity = useMemo(makeIdentity, []);
  const [joined, setJoined] = useState(false);
  const [devices, setDevices] = useState<LobbyDeviceState | null>(null);

  const setRoomId = useRoomStore((s) => s.setRoomId);
  const setRole = useRoomStore((s) => s.setRole);
  const setName = useRoomStore((s) => s.setName);
  const setIdentity = useRoomStore((s) => s.setIdentity);
  const setConnectionState = useRoomStore((s) => s.setConnectionState);
  const setLiveKitCredentials = useRoomStore((s) => s.setLiveKitCredentials);
  const clearLiveKitCredentials = useRoomStore((s) => s.clearLiveKitCredentials);

  useEffect(() => {
    setRoomId(roomId);
    setRole(role);
    setName(name);
    setIdentity(identity);
    return () => {
      setConnectionState("idle");
      clearLiveKitCredentials();
    };
  }, [
    roomId,
    role,
    name,
    identity,
    setRoomId,
    setRole,
    setName,
    setIdentity,
    setConnectionState,
    clearLiveKitCredentials,
  ]);

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

  const handleJoin = async (d: LobbyDeviceState): Promise<void> => {
    setDevices(d);
    setConnectionState("connecting");
    try {
      const creds = await mintLiveKitToken({ roomId, identity, name, role });
      setLiveKitCredentials({
        wsUrl: creds.wsUrl,
        token: creds.token,
        tokenExpiresAt: creds.tokenExpiresAt,
      });
      setJoined(true);
    } catch (err) {
      console.error("[room] token mint failed", err);
      setConnectionState("disconnected");
      clearLiveKitCredentials();
      toast.error("Could not get a room token — try again.");
      throw err;
    }
  };

  if (!joined || !devices) {
    return (
      <Lobby
        roomId={roomId}
        displayName={name}
        role={role}
        onJoin={handleJoin}
        onCancel={() => router.push("/start")}
      />
    );
  }

  return (
    <ActiveRoom
      roomId={roomId}
      displayName={name}
      role={role}
      devices={devices}
      onLeave={() => router.push("/")}
    />
  );
}

interface ActiveRoomProps {
  roomId: string;
  displayName: string;
  role: Role;
  devices: LobbyDeviceState;
  onLeave: () => void;
}

function ActiveRoom({
  roomId,
  displayName,
  role,
  devices,
  onLeave,
}: ActiveRoomProps) {
  const [view, setView] = useState<ViewMode>("production");
  const [chatOpen, setChatOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const {
    localVideoTrack,
    remoteVideoTrack,
    remoteAudioTrack,
    remoteName,
    remoteRole,
    micEnabled,
    camEnabled,
    toggleMic,
    toggleCamera,
    leave,
    publish,
  } = useLiveKitRoom({
    audioInputDeviceId: devices.audioInputDeviceId,
    videoInputDeviceId: devices.videoInputDeviceId,
    audioOutputDeviceId: devices.audioOutputDeviceId,
    initialMicEnabled: devices.micEnabled,
    initialCamEnabled: devices.camEnabled,
  });

  useDevWindowHandle(publish);

  const handleLeave = async () => {
    await leave();
    onLeave();
  };

  return (
    <main className="relative flex h-dvh flex-col overflow-hidden bg-sc-bg text-sc-text">
      <div className="flex min-h-0 flex-1 bg-sc-surface-2">
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-28">
              <div className="w-full shrink-0 px-1 pt-1 sm:px-2 sm:pt-2">
                <div className="grid w-full grid-cols-2 gap-1 sm:gap-2 md:gap-3">
                  <div className="min-w-0">
                    <VideoTile
                      label={`${displayName} · you (${role})`}
                      role={role}
                      videoTrack={localVideoTrack}
                      mirrored
                    />
                  </div>
                  <div className="min-w-0">
                    {remoteVideoTrack || remoteAudioTrack || remoteName ? (
                      <VideoTile
                        label={`${remoteName ?? "guest"}${remoteRole ? ` (${remoteRole})` : ""}`}
                        role={remoteRole}
                        videoTrack={remoteVideoTrack}
                        audioTrack={remoteAudioTrack}
                        audioOutputDeviceId={devices.audioOutputDeviceId}
                      />
                    ) : (
                      <VideoTile empty />
                    )}
                  </div>
                </div>
              </div>
            </div>

            <ControlBar
              micEnabled={micEnabled}
              camEnabled={camEnabled}
              chatOpen={chatOpen}
              settingsOpen={settingsOpen}
              onToggleMic={() => void toggleMic()}
              onToggleCam={() => void toggleCamera()}
              onToggleChat={() => setChatOpen((v) => !v)}
              onToggleSettings={() => setSettingsOpen((v) => !v)}
              onLeave={() => void handleLeave()}
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

      <RoomSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        roomId={roomId}
        view={view}
        onViewChange={setView}
      />
    </main>
  );
}
