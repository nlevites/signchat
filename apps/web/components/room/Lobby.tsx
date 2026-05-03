"use client";

import {
  ArrowLeft,
  CheckCircle,
  CircleNotch,
  Microphone,
  MicrophoneSlash,
  VideoCamera,
  VideoCameraSlash,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Role } from "@signchat/contracts";
import { Logo } from "@/components/ui/Logo";
import { DevicePicker } from "@/components/room/DevicePicker";
import { enumerateMediaDevices } from "@/lib/livekit/devices";
import { usePreferencesStore } from "@/lib/stores";
import { prewarmVad, prewarmWhisper, type PrewarmProgress } from "@/lib/whisper-prewarm";

export interface LobbyDeviceState {
  audioInputDeviceId: string;
  videoInputDeviceId: string;
  audioOutputDeviceId: string;
  micEnabled: boolean;
  camEnabled: boolean;
}

interface LobbyProps {
  roomId: string;
  displayName: string;
  role: Role;
  onJoin: (devices: LobbyDeviceState) => void | Promise<void>;
  onCancel: () => void;
}

type PrewarmStatus = "idle" | "preparing" | "ready" | "error";

export function Lobby({ roomId, displayName, role, onJoin, onCancel }: LobbyProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const whisperModelId = usePreferencesStore((s) => s.whisperModelId);
  const [audioInputs, setAudioInputs] = useState<readonly MediaDeviceInfo[]>([]);
  const [videoInputs, setVideoInputs] = useState<readonly MediaDeviceInfo[]>([]);
  const [audioOutputs, setAudioOutputs] = useState<readonly MediaDeviceInfo[]>([]);
  const [audioInputId, setAudioInputId] = useState<string>("");
  const [videoInputId, setVideoInputId] = useState<string>("");
  const [audioOutputId, setAudioOutputId] = useState<string>("");
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [joining, setJoining] = useState(false);
  const [prewarmStatus, setPrewarmStatus] = useState<PrewarmStatus>(
    role === "deaf" ? "preparing" : "ready",
  );
  const [prewarmProgress, setPrewarmProgress] = useState(0);
  const [prewarmFile, setPrewarmFile] = useState<string | null>(null);
  const [prewarmError, setPrewarmError] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const acquireStream = useCallback(
    async (audioId: string, videoId: string, audio: boolean, video: boolean) => {
      try {
        stopStream();
        if (!audio && !video) {
          setReady(true);
          return;
        }
        const constraints: MediaStreamConstraints = {
          audio: audio ? (audioId ? { deviceId: { exact: audioId } } : true) : false,
          video: video
            ? videoId
              ? { deviceId: { exact: videoId } }
              : { width: { ideal: 1280 }, height: { ideal: 720 } }
            : false,
        };
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        if (videoRef.current) videoRef.current.srcObject = stream;
        // first acquisition picks reasonable defaults if state hasn't been set yet
        const audioTrack = stream.getAudioTracks()[0];
        const videoTrack = stream.getVideoTracks()[0];
        if (!audioId && audioTrack) {
          setAudioInputId((prev) => prev || audioTrack.getSettings().deviceId || "");
        }
        if (!videoId && videoTrack) {
          setVideoInputId((prev) => prev || videoTrack.getSettings().deviceId || "");
        }
        setError(null);
        setReady(true);
      } catch (err) {
        setReady(false);
        setError(explainAcquireError(err));
      }
    },
    [stopStream],
  );

  // initial acquisition + device enumeration. runs once on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      await acquireStream("", "", true, true);
      if (cancelled) return;
      const list = await enumerateMediaDevices();
      if (cancelled) return;
      setAudioInputs(list.audioInputs);
      setVideoInputs(list.videoInputs);
      setAudioOutputs(list.audioOutputs);
      setAudioOutputId((prev) => prev || list.audioOutputs[0]?.deviceId || "");
    })();
    return () => {
      cancelled = true;
      stopStream();
    };
  }, []);

  // re-acquire on selection / enable changes. skip before the first successful
  // acquisition so we don't thrash mid-init. acquireStream is stable via
  // useCallback so it's intentionally omitted from deps.
  useEffect(() => {
    if (!streamRef.current && !ready) return;
    void acquireStream(audioInputId, videoInputId, micEnabled, camEnabled);
  }, [audioInputId, videoInputId, micEnabled, camEnabled]);

  // deaf-side: prewarm whisper + silero vad while the user picks devices, so
  // models are hot in indexeddb by join. hearing role skips this entirely.
  useEffect(() => {
    if (role !== "deaf") return;
    let cancelled = false;
    setPrewarmStatus("preparing");
    setPrewarmProgress(0);
    setPrewarmFile(null);
    setPrewarmError(null);
    const onProgress = (p: PrewarmProgress) => {
      if (cancelled) return;
      if (p.file) setPrewarmFile(p.file);
      if (p.status === "progress" && typeof p.progress === "number") {
        setPrewarmProgress(p.progress);
      }
      if (p.status === "done" || p.status === "ready") {
        setPrewarmProgress(100);
      }
    };
    Promise.all([prewarmWhisper(whisperModelId, onProgress), prewarmVad()])
      .then(() => {
        if (cancelled) return;
        setPrewarmStatus("ready");
        setPrewarmProgress(100);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[lobby] prewarm failed", err);
        setPrewarmStatus("error");
        setPrewarmError(err instanceof Error ? err.message : "unknown error");
      });
    return () => {
      cancelled = true;
    };
  }, [role, whisperModelId]);

  const handleJoin = async () => {
    if (joining) return;
    setJoining(true);
    // release the preview tracks before livekit re-acquires the same device id —
    // macos sometimes throws NotReadableError without a brief release window.
    stopStream();
    await new Promise((r) => setTimeout(r, 200));
    try {
      await onJoin({
        audioInputDeviceId: audioInputId,
        videoInputDeviceId: videoInputId,
        audioOutputDeviceId: audioOutputId,
        micEnabled,
        camEnabled,
      });
    } catch {
      // parent surfaces a toast + flips connection state; re-enable the join
      // button so the user can retry without leaving the lobby.
      setJoining(false);
      void acquireStream(audioInputId, videoInputId, micEnabled, camEnabled);
    }
  };

  return (
    <main className="relative flex min-h-dvh justify-center bg-sc-bg px-6 py-12">
      <div className="flex w-full max-w-[520px] flex-col gap-6">
        <header className="flex flex-col gap-3">
          <Logo size={56} wordmarkSize={36} surface="solid" />
          <div className="flex flex-col gap-1">
            <p className="t-meta uppercase text-sc-accent-700">Ready to join</p>
            <h1 className="t-h1 text-sc-text">
              Room <span className="font-mono">{roomId}</span>
            </h1>
            <p className="t-body-sm text-sc-text-2">
              Joining as <span className="font-medium text-sc-text">{displayName}</span>
              {" · "}
              <span className="capitalize">{role}</span> role.
            </p>
          </div>
        </header>

        <div className="relative">
          <div className="sc-tile-placeholder relative aspect-[4/3] w-full overflow-hidden rounded-sc-2xl border border-sc-border shadow-sc-md">
            <video
              ref={videoRef}
              className="absolute inset-0 size-full object-cover"
              autoPlay
              playsInline
              muted
            />
            {!camEnabled || !ready ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sc-text-2">
                <VideoCameraSlash size={28} weight="fill" />
                <span className="t-body-sm">
                  {!camEnabled
                    ? "Camera off"
                    : error
                      ? "Preview blocked"
                      : "Connecting camera…"}
                </span>
              </div>
            ) : null}
            <div className="absolute bottom-3 left-3 rounded-sc-full bg-black/55 px-3 py-1 text-[13px] font-medium text-white backdrop-blur">
              {displayName} · you ({role})
            </div>
          </div>

          <div className="absolute -bottom-5 left-1/2 z-10 -translate-x-1/2">
            <div className="flex items-center gap-2 rounded-sc-full border border-sc-border bg-sc-surface p-2 shadow-sc-md">
              <ToggleControl
                label={micEnabled ? "Mute mic" : "Unmute mic"}
                onClick={() => setMicEnabled((v) => !v)}
                muted={!micEnabled}
              >
                {micEnabled ? (
                  <Microphone size={18} weight="fill" />
                ) : (
                  <MicrophoneSlash size={18} weight="fill" />
                )}
              </ToggleControl>
              <ToggleControl
                label={camEnabled ? "Turn camera off" : "Turn camera on"}
                onClick={() => setCamEnabled((v) => !v)}
                muted={!camEnabled}
              >
                {camEnabled ? (
                  <VideoCamera size={18} weight="fill" />
                ) : (
                  <VideoCameraSlash size={18} weight="fill" />
                )}
              </ToggleControl>
            </div>
          </div>
        </div>

        <section className="mt-4 flex flex-col gap-4 rounded-sc-2xl border border-sc-border bg-sc-surface p-5 shadow-sc-sm">
          <p className="t-meta uppercase text-sc-text-3">Devices</p>
          <DevicePicker
            kind="videoinput"
            devices={videoInputs}
            value={videoInputId}
            onChange={setVideoInputId}
          />
          <DevicePicker
            kind="audioinput"
            devices={audioInputs}
            value={audioInputId}
            onChange={setAudioInputId}
          />
          <DevicePicker
            kind="audiooutput"
            devices={audioOutputs}
            value={audioOutputId}
            onChange={setAudioOutputId}
          />
          {error ? (
            <p className="t-body-sm rounded-sc-md bg-sc-warning-subtle px-3 py-2 text-sc-warning">
              {error}
            </p>
          ) : null}
        </section>

        {role === "deaf" ? (
          <PrewarmChip
            status={prewarmStatus}
            progress={prewarmProgress}
            file={prewarmFile}
            error={prewarmError}
          />
        ) : null}

        <button
          type="button"
          onClick={() => void handleJoin()}
          disabled={
            !ready || joining || (role === "deaf" && prewarmStatus !== "ready")
          }
          className="sc-luminous mt-2 inline-flex h-12 w-full items-center justify-center rounded-sc-full px-6 text-[15px] font-medium transition-[transform,filter] duration-200 hover:-translate-y-px hover:brightness-105 active:translate-y-0 disabled:opacity-40 disabled:pointer-events-none"
        >
          {joining ? "Joining…" : "Join now"}
        </button>

        <button
          type="button"
          onClick={onCancel}
          className="inline-flex items-center justify-center gap-2 self-center rounded-sc-md px-3 py-2 t-label text-sc-text-3 transition-colors duration-150 hover:text-sc-text-2"
        >
          <ArrowLeft size={14} weight="bold" />
          Back
        </button>
      </div>
    </main>
  );
}

interface PrewarmChipProps {
  status: PrewarmStatus;
  progress: number;
  file: string | null;
  error: string | null;
}

function PrewarmChip({ status, progress, file, error }: PrewarmChipProps) {
  if (status === "ready") {
    return (
      <div className="inline-flex items-center gap-2 self-center rounded-sc-full bg-sc-success-subtle px-3 py-1.5 t-body-sm text-sc-success">
        <CheckCircle size={16} weight="fill" />
        Captions ready
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className="flex flex-col gap-2 rounded-sc-md bg-sc-warning-subtle p-3 text-sc-warning">
        <div className="flex items-center gap-2 t-body-sm font-medium">
          <WarningCircle size={16} weight="fill" />
          Captions failed to load
        </div>
        {error ? (
          <p className="t-body-sm text-sc-text-2">
            {error}. Reload the page to retry.
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-sc-md bg-sc-accent-soft p-3 text-sc-accent-700">
      <div className="flex items-center gap-2 t-body-sm font-medium">
        <CircleNotch size={16} weight="bold" className="animate-spin" />
        <span className="flex-1">Preparing captions</span>
        <span className="font-mono text-[12px]">{Math.round(progress)}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-sc-full bg-sc-accent-soft-2">
        <div
          className="h-full rounded-sc-full bg-sc-accent-500 transition-[width] duration-200"
          style={{ width: `${Math.max(2, progress)}%` }}
        />
      </div>
      {file ? (
        <p className="truncate font-mono text-[11px] text-sc-text-3">{file}</p>
      ) : null}
    </div>
  );
}

interface ToggleControlProps {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  muted?: boolean;
}

function ToggleControl({ children, label, onClick, muted }: ToggleControlProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={
        "inline-flex size-10 items-center justify-center rounded-sc-full transition-[background-color,color] duration-200 " +
        (muted
          ? "bg-sc-danger text-white"
          : "bg-transparent text-sc-text hover:bg-sc-surface-2")
      }
    >
      {children}
    </button>
  );
}

function explainAcquireError(err: unknown): string {
  if (
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1"
  ) {
    return `Open this app at http://localhost:${window.location.port || "3000"} — browsers refuse getUserMedia on non-localhost HTTP origins.`;
  }
  if (!(err instanceof Error)) return "Could not acquire camera/mic.";
  const name = (err as Error & { name?: string }).name;
  if (name === "NotAllowedError") {
    return "Permission denied. Click the lock icon in the URL bar → set Camera & Microphone to Allow → refresh.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No camera or microphone detected. Plug one in (or check OS-level privacy) and refresh.";
  }
  if (name === "NotReadableError") {
    return "Camera/mic is in use by another app. Close other meeting apps and refresh.";
  }
  return err.message;
}
