"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  CaptureMode,
  ParticipantInfo,
  Role,
} from "@signchat/contracts";
import { Logo } from "@/components/ui/Logo";
import { CaptureControls } from "@/components/room/CaptureControls";
import { ChatPanel } from "@/components/room/ChatPanel";
import { ControlBar } from "@/components/room/ControlBar";
import { ConnectionBadge } from "@/components/room/ConnectionBadge";
import { DeafSession } from "@/components/room/DeafSession";
import { DebugView } from "@/components/room/DebugView";
import { Lobby, type LobbyDeviceState } from "@/components/room/Lobby";
import { SettingsPanel } from "@/components/room/SettingsPanel";
import { TranscriptStrip } from "@/components/room/TranscriptStrip";
import { VideoTile } from "@/components/room/VideoTile";
import { ViewToggle, type ViewMode } from "@/components/room/ViewToggle";
import { LogStream } from "@/components/room/debug/LogStream";
import { useCredentialsStore } from "@/lib/credentials/store";
import { useDevWindowHandle } from "@/lib/dev-window";
import { mintElevenLabsSignedUrl } from "@/lib/livekit/mint-elevenlabs";
import { mintLiveKitToken } from "@/lib/livekit/mint-token";
import { mintOpenRouterSessionKey } from "@/lib/livekit/mint-openrouter";
import { useLiveKitRoom } from "@/lib/livekit/room";
import {
  ControllerStore,
  useModeSnapshot,
} from "@signchat/runtime-browser/mode-controller/controller-store";
import {
  usePreferencesStore,
  useRoomStore,
  useTranscriptStore,
} from "@/lib/stores";
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
  const setOpenRouter = useCredentialsStore((s) => s.setOpenRouter);
  const setElevenLabs = useCredentialsStore((s) => s.setElevenLabs);
  const clearCredentials = useCredentialsStore((s) => s.clear);

  useEffect(() => {
    setRoomId(roomId);
    setRole(role);
    setName(name);
    setIdentity(identity);
    return () => {
      setConnectionState("idle");
      clearLiveKitCredentials();
      clearCredentials();
      // Reset ephemeral session state so navigating into a fresh room
      // doesn't carry over chat history, captions, or remote-participant
      // metadata from the previous call.
      useTranscriptStore.getState().clear();
      useRoomStore.getState().reset();
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
    clearCredentials,
  ]);

  useEffect(() => {
    if (role) return;
    router.replace(`/start?room=${encodeURIComponent(roomId)}`);
  }, [role, roomId, router]);

  if (!role) return null;

  const handleJoin = async (d: LobbyDeviceState): Promise<void> => {
    setDevices(d);
    setConnectionState("connecting");
    // Read the picked voice once at join time; in-call swaps go through
    // SettingsPanel's onVoiceChange and re-mint independently.
    const voiceId =
      usePreferencesStore.getState().elevenlabsVoiceId ?? undefined;
    try {
      // LiveKit + (Deaf only) OpenRouter + ElevenLabs all mint in parallel
      // so the join click → connected transition isn't serialized.
      const [creds, sessionCreds] = await Promise.all([
        mintLiveKitToken({ roomId, identity, name, role }),
        role === "deaf"
          ? Promise.all([
              mintOpenRouterSessionKey({ roomId, identity, role: "deaf" }),
              mintElevenLabsSignedUrl({
                roomId,
                identity,
                role: "deaf",
                ...(voiceId ? { voiceId } : {}),
              }),
            ])
          : Promise.resolve(null),
      ]);
      setLiveKitCredentials({
        wsUrl: creds.wsUrl,
        token: creds.token,
        tokenExpiresAt: creds.tokenExpiresAt,
      });
      if (sessionCreds) {
        const [or, el] = sessionCreds;
        setOpenRouter({
          apiKey: or.apiKey,
          modelId: or.modelId,
          limitCredits: or.limitCredits,
          keyHash: or.keyHash,
          label: or.label,
          createdAt: or.createdAt,
        });
        setElevenLabs({
          signedUrl: el.signedUrl,
          voiceId: el.voiceId,
          modelId: el.modelId,
          outputFormat: el.outputFormat,
          expiresAt: el.expiresAt,
        });
      }
      setJoined(true);
    } catch (err) {
      console.error("[room] credential mint failed", err);
      setConnectionState("disconnected");
      clearLiveKitCredentials();
      clearCredentials();
      toast.error("Could not get session credentials — try again.");
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

  const identity = useRoomStore((s) => s.identity);
  const prefsMode = usePreferencesStore((s) => s.mode);
  const setPrefsMode = usePreferencesStore((s) => s.setMode);
  const prefsThresholds = usePreferencesStore((s) => s.thresholds);
  const modeSnapshot = useModeSnapshot();

  const {
    room,
    localVideoTrack,
    remoteVideoTrack,
    remoteAudioTrack,
    remoteIdentity,
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

  const isDeaf = role === "deaf";

  const [inviteUrl, setInviteUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setInviteUrl(`${window.location.origin}/room/${encodeURIComponent(roomId)}`);
  }, [roomId]);

  // Build the last 4 dialog turns from the Deaf signer's perspective for the
  // reconstruction prompt, formatted as `You said:` (own captions, post-TTS)
  // and `They said:` (hearing user's finalized STT). Read lazily so the
  // DeafSession stitching effect doesn't re-fire on every transcript update.
  // Partials are intentionally excluded — they represent an in-progress
  // utterance, not a completed turn.
  const recentDialogContext = useCallback((): string[] => {
    const messages = useTranscriptStore.getState().messages;
    const turns: string[] = [];
    for (let i = messages.length - 1; i >= 0 && turns.length < 4; i--) {
      const m = messages[i];
      if (!m) continue;
      if (m.kind === "caption" && m.sentence.length > 0) {
        turns.push(`You said: ${m.sentence}`);
      } else if (m.kind === "transcript_final" && m.text.length > 0) {
        turns.push(`They said: ${m.text}`);
      }
    }
    return turns.reverse();
  }, []);

  const participantInfo: ParticipantInfo = {
    identity: identity ?? "(you)",
    name: displayName,
    role,
  };

  const onSetMode = useCallback(
    (mode: CaptureMode) => {
      setPrefsMode(mode);
      ControllerStore.current()?.setMode(mode);
    },
    [setPrefsMode],
  );

  const onStartCapture = useCallback(() => {
    ControllerStore.current()?.start();
  }, []);
  const onStopManual = useCallback(() => {
    ControllerStore.current()?.stopManual();
  }, []);
  const onCancelCapture = useCallback(() => {
    ControllerStore.current()?.cancel();
  }, []);

  const canStart =
    isDeaf &&
    modeSnapshot.state === "idle" &&
    Boolean(localVideoTrack) &&
    useCredentialsStore.getState().openrouter !== null &&
    useCredentialsStore.getState().elevenlabs !== null;

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
          <ConnectionBadge />
        </div>
        <ViewToggle value={view} onChange={setView} />
      </header>

      <div className="flex min-h-0 flex-1 bg-sc-surface-2">
        <section className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-6 pt-6 pb-24">
            <div className="grid h-full max-h-full w-full max-w-[1200px] grid-cols-1 content-center gap-4 md:grid-cols-2">
              <div className="relative">
                <VideoTile
                  label={`${displayName} · you (${role})`}
                  role={role}
                  videoTrack={localVideoTrack}
                  mirrored
                  tileIdentity={identity ?? undefined}
                  tileRole={role}
                  showHearingPartials={role === "hearing"}
                  showDeafCaption={role === "deaf"}
                />
                {isDeaf ? (
                  <DeafSession
                    room={room}
                    localVideoTrack={localVideoTrack}
                    remoteAudioTrack={remoteAudioTrack}
                    participantInfo={participantInfo}
                    recentDialogContext={recentDialogContext}
                    publish={publish}
                  />
                ) : null}
              </div>
              {remoteVideoTrack || remoteAudioTrack || remoteName ? (
                <VideoTile
                  label={`${remoteName ?? "guest"}${remoteRole ? ` (${remoteRole})` : ""}`}
                  role={remoteRole}
                  videoTrack={remoteVideoTrack}
                  audioTrack={remoteAudioTrack}
                  audioOutputDeviceId={devices.audioOutputDeviceId}
                  tileIdentity={remoteIdentity ?? undefined}
                  tileRole={remoteRole}
                  showHearingPartials={remoteRole === "hearing"}
                  showDeafCaption={remoteRole === "deaf"}
                />
              ) : (
                <VideoTile
                  empty
                  inviteRoomCode={roomId}
                  inviteUrl={inviteUrl}
                />
              )}
            </div>

            {isDeaf ? (
              <div className="absolute bottom-20 left-1/2 z-30 -translate-x-1/2">
                <CaptureControls
                  mode={prefsMode}
                  state={modeSnapshot.state}
                  buffer={modeSnapshot.buffer}
                  silenceMs={prefsThresholds.silenceMs}
                  lowConfidenceStartedAt={modeSnapshot.lowConfidenceStartedAt}
                  canStart={canStart}
                  onSetMode={onSetMode}
                  onStart={onStartCapture}
                  onStopManual={onStopManual}
                  onCancel={onCancelCapture}
                />
              </div>
            ) : null}

            <ControlBar
              micEnabled={micEnabled}
              camEnabled={camEnabled}
              chatOpen={chatOpen}
              settingsOpen={settingsOpen}
              onToggleMic={() => void toggleMic()}
              onToggleCam={() => void toggleCamera()}
              onToggleChat={() => {
                setChatOpen((v) => !v);
                setSettingsOpen(false);
              }}
              onToggleSettings={() => {
                setSettingsOpen((v) => !v);
                setChatOpen(false);
              }}
              onLeave={() => void handleLeave()}
            />
          </div>

          <TranscriptStrip />

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
                <div className="max-h-[50vh] overflow-y-auto">
                  <DebugView />
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>

          {view === "debug" ? <LogStream /> : null}
        </section>

        <motion.aside
          className="relative shrink-0 overflow-hidden border-l border-sc-border"
          initial={false}
          animate={{ width: chatOpen || settingsOpen ? 360 : 0 }}
          transition={{ duration: 0.52, ease: [0.32, 0.72, 0, 1] }}
        >
          <div className="absolute inset-y-0 right-0 flex w-[360px] flex-col">
            {settingsOpen ? (
              <SettingsPanel
                role={role}
                onClose={() => setSettingsOpen(false)}
              />
            ) : (
              <ChatPanel
                participantInfo={participantInfo}
                publish={publish}
              />
            )}
          </div>
        </motion.aside>
      </div>
    </main>
  );
}
