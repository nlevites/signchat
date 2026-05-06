"use client";

import {
  Check,
  Copy,
  Ear,
  HandWaving,
  MicrophoneSlash,
  UserCircle,
  VideoCameraSlash,
} from "@phosphor-icons/react/dist/ssr";
import type {
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
} from "livekit-client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type {
  CaptionMessage,
  Role,
  TranscriptFinalMessage,
} from "@signchat/contracts";
import { useTranscriptStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

// §6.2: caption stays pinned through the duration of TTS playback. 8 s covers
// the long tail of ElevenLabs Flash v2.5 turns; after that the caption hands
// off to the global TranscriptStrip below the cameras.
const DEAF_CAPTION_HOLD_MS = 8000;

// On the Hearing tile, pin the most recent finalized transcript for a few
// seconds after speech-end so the user sees what was just said before it
// migrates into the global TranscriptStrip. Without this fallback, finals
// only surface in the small strip below the cameras and the in-tile
// partial vanishes the instant STT commits.
const HEARING_FINAL_HOLD_MS = 6000;

interface VideoTileProps {
  label?: string;
  role?: Role | null;
  videoTrack?: LocalVideoTrack | RemoteVideoTrack | null;
  audioTrack?: RemoteAudioTrack | null;
  audioOutputDeviceId?: string;
  mirrored?: boolean;
  empty?: boolean;
  emptyText?: string;
  /** Identity of the participant displayed on this tile. Used to filter captions/partials. */
  tileIdentity?: string;
  /** Role of the participant displayed on this tile. */
  tileRole?: Role | null;
  /** Show streaming partials when this tile is the Hearing speaker. */
  showHearingPartials?: boolean;
  /** Show pinned caption when this tile is the Deaf signer during TTS. */
  showDeafCaption?: boolean;
  /** Room code shown alongside a copy button in the empty waiting state. */
  inviteRoomCode?: string;
  /** Full shareable URL copied to the clipboard from the empty waiting state. */
  inviteUrl?: string;
  /** Show a small "Connected" pill at top-left when this tile holds a real
   * participant (local: always true once joined; remote: true once their
   * identity is known). null/undefined hides the badge. */
  connected?: boolean;
  /** Drives the on-tile mic-off / camera-off chips. when false, both users
   * see this tile is muted / camera-off. defaults to true (no chip). */
  micOn?: boolean;
  camOn?: boolean;
  /** Click handler — used by the room layout to swap the main tile and the
   * PiP. when set, the tile gets cursor:pointer and reacts to Enter/Space. */
  onClick?: () => void;
}

export function VideoTile({
  label,
  role,
  videoTrack,
  audioTrack,
  audioOutputDeviceId,
  mirrored = false,
  empty = false,
  emptyText,
  tileIdentity,
  tileRole,
  showHearingPartials = false,
  showDeafCaption = false,
  inviteRoomCode,
  inviteUrl,
  connected,
  micOn = true,
  camOn = true,
  onClick,
}: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (videoTrack) {
      videoTrack.attach(el);
      return () => {
        videoTrack.detach(el);
      };
    }
    el.srcObject = null;
    return undefined;
  }, [videoTrack]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioTrack) return;
    audioTrack.attach(el);
    return () => {
      audioTrack.detach(el);
    };
  }, [audioTrack]);

  useEffect(() => {
    const el = audioRef.current;
    if (!el || !audioOutputDeviceId) return;
    const withSink = el as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>;
    };
    if (typeof withSink.setSinkId !== "function") return;
    withSink.setSinkId(audioOutputDeviceId).catch((err) => {
      console.warn("[tile] setSinkId failed", err);
    });
  }, [audioOutputDeviceId, audioTrack]);

  // Selectors return primitives / stable message refs so unrelated transcript
  // updates (chat, the *other* tile's partials) don't re-render this tile.
  const hearingPartialText = useTranscriptStore((s) => {
    if (!showHearingPartials) return null;
    let bestText: string | null = null;
    let bestTs = -Infinity;
    for (const entry of Object.values(s.partialsByUtterance)) {
      const matches = tileIdentity
        ? entry.from.identity === tileIdentity
        : entry.from.role === "hearing";
      if (!matches) continue;
      if (entry.ts > bestTs) {
        bestTs = entry.ts;
        bestText = entry.text;
      }
    }
    return bestText;
  });

  const latestDeafCaption = useTranscriptStore((s): CaptionMessage | null => {
    if (!showDeafCaption) return null;
    for (let i = s.messages.length - 1; i >= 0; i--) {
      const m = s.messages[i];
      if (!m || m.kind !== "caption") continue;
      const matches = tileIdentity
        ? m.from.identity === tileIdentity
        : m.from.role === "deaf";
      if (matches) return m;
    }
    return null;
  });

  const latestHearingFinal = useTranscriptStore(
    (s): TranscriptFinalMessage | null => {
      if (!showHearingPartials) return null;
      for (let i = s.messages.length - 1; i >= 0; i--) {
        const m = s.messages[i];
        if (!m || m.kind !== "transcript_final") continue;
        const matches = tileIdentity
          ? m.from.identity === tileIdentity
          : m.from.role === "hearing";
        if (matches) return m;
      }
      return null;
    },
  );

  const captionsDegradedChip = useTranscriptStore(
    (s) =>
      s.captionsDegraded && tileRole === "hearing" && showHearingPartials,
  );

  // Re-tick once a second so the hold-window can expire without any external
  // nudge. Only runs while there's a candidate caption pinned to this tile.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!latestDeafCaption && !latestHearingFinal) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [latestDeafCaption, latestHearingFinal]);

  const deafCaptionVisible =
    latestDeafCaption !== null &&
    nowMs > 0 &&
    nowMs < latestDeafCaption.playAtMs + DEAF_CAPTION_HOLD_MS;

  const hearingFinalWithinHold =
    latestHearingFinal !== null &&
    nowMs > 0 &&
    nowMs < latestHearingFinal.ts + HEARING_FINAL_HOLD_MS
      ? latestHearingFinal
      : null;
  // Prefer the live partial; fall back to the most recent final inside its
  // hold window. Either way the overlay slot stays occupied for the
  // duration of an utterance + a short tail, so the speaker always sees
  // their own transcription land.
  const hearingDisplayText =
    hearingPartialText ?? hearingFinalWithinHold?.text ?? null;

  // a tile renders the live video only when the track is present AND the
  // publisher has the camera on. when they toggle camera off mid-call we
  // still hold the muted track but should swap to the avatar placeholder
  // so the other side can see the camera is intentionally off.
  const showVideo = !!videoTrack && camOn !== false;
  const showCameraOff = !empty && !showVideo;
  const showMicOff = !empty && !micOn;

  const interactive = !!onClick;
  const Tag = (interactive ? "button" : "div") as "button" | "div";
  const interactiveProps = interactive
    ? {
        type: "button" as const,
        onClick,
        "aria-label": label ? `Expand ${label}'s tile` : "Expand tile",
      }
    : {};

  return (
    <Tag
      {...interactiveProps}
      className={
        "group relative aspect-video w-full overflow-hidden rounded-sc-xl border border-sc-border bg-[var(--sc-hero-deep)] text-left shadow-sc-md transition-shadow duration-200 " +
        (interactive
          ? "cursor-pointer hover:shadow-sc-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sc-focus"
          : "")
      }
    >
      <div className="sc-tile-placeholder absolute inset-0" />
      {showVideo ? (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={
            "absolute inset-0 size-full object-cover " +
            (mirrored ? "scale-x-[-1]" : "")
          }
        />
      ) : null}
      {audioTrack ? (
        <audio ref={audioRef} autoPlay className="hidden" />
      ) : null}
      {empty ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 py-3 text-center sm:gap-3 sm:p-6">
          <p className="t-h3 break-words text-sc-text">
            {emptyText ?? "Waiting for the second participant…"}
          </p>
          <p className="t-body-sm text-sc-text-2">
            Share the room link to invite them.
          </p>
          {inviteRoomCode || inviteUrl ? (
            <InviteCopy roomCode={inviteRoomCode} inviteUrl={inviteUrl} />
          ) : null}
        </div>
      ) : null}
      {showCameraOff ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--sc-hero-deep)]/85 text-white/85">
          <UserCircle size={64} weight="duotone" />
          <span className="t-body-sm font-medium">Camera off</span>
          {label ? (
            <span className="t-meta uppercase text-white/55">{label}</span>
          ) : null}
        </div>
      ) : null}
      {connected && !empty ? (
        <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-sc-full bg-emerald-500/90 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          <span aria-hidden className="inline-block size-1.5 rounded-full bg-white" />
          Connected
        </span>
      ) : null}
      {showMicOff ? (
        <span className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-sc-full bg-rose-500/90 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          <MicrophoneSlash size={11} weight="fill" />
          Muted
        </span>
      ) : null}
      {showVideo && !camOn ? null : null}
      {/* fallback explicit small camera-off chip when the avatar
        * placeholder is suppressed (e.g. for local PiP shrunk states). */}
      {!showVideo && !empty ? (
        <span className="absolute right-3 bottom-3 inline-flex items-center gap-1.5 rounded-sc-full bg-black/55 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          <VideoCameraSlash size={11} weight="fill" />
          Camera off
        </span>
      ) : null}
      {captionsDegradedChip ? (
        <div className="absolute top-3 right-3 inline-flex items-center gap-1.5 rounded-sc-full bg-sc-warning/90 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          <span
            aria-hidden
            className="inline-block size-1.5 rounded-full bg-white/85"
          />
          captions: degraded
        </div>
      ) : null}
      {hearingDisplayText ? (
        <div
          aria-live="polite"
          className="absolute right-3 bottom-12 left-3 rounded-sc-md bg-black/65 px-3 py-1.5 text-balance text-white backdrop-blur"
        >
          <span className="t-body-sm line-clamp-2 leading-snug">
            {hearingDisplayText}
          </span>
        </div>
      ) : null}
      <AnimatePresence>
        {deafCaptionVisible && latestDeafCaption ? (
          <motion.div
            key={latestDeafCaption.id}
            role="status"
            aria-live="polite"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            transition={{ duration: 0.18, ease: [0.32, 0.72, 0, 1] }}
            className="absolute right-3 bottom-12 left-3 rounded-sc-md border border-sc-accent-300/50 bg-black/65 px-3 py-1.5 text-balance text-white backdrop-blur"
          >
            <span className="t-body-sm line-clamp-2 leading-snug">
              {latestDeafCaption.sentence}
            </span>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {label ? (
        <div className="absolute bottom-3 left-3 inline-flex items-center gap-2 rounded-sc-full bg-black/55 px-3 py-1 text-[13px] font-medium text-white backdrop-blur">
          {role ? (
            <span
              aria-hidden
              className="inline-flex size-4 items-center justify-center"
            >
              {role === "deaf" ? (
                <HandWaving size={14} weight="fill" />
              ) : (
                <Ear size={14} weight="fill" />
              )}
            </span>
          ) : null}
          {label}
        </div>
      ) : null}
    </Tag>
  );
}

interface InviteCopyProps {
  roomCode?: string;
  inviteUrl?: string;
}

function InviteCopy({ roomCode, inviteUrl }: InviteCopyProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success("Room link copied");
    } catch (err) {
      console.warn("[invite] clipboard write failed", err);
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="mt-1 inline-flex items-center gap-2 rounded-sc-full border border-sc-border bg-sc-surface/90 px-1 py-1 shadow-sc-sm backdrop-blur">
      {roomCode ? (
        <span className="inline-flex items-center gap-1.5 px-2.5 t-meta uppercase text-sc-text-3">
          Room
          <code className="font-mono text-[13px] font-medium tracking-wide text-sc-text">
            {roomCode}
          </code>
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => void handleCopy()}
        disabled={!inviteUrl}
        aria-label="Copy room link"
        title="Copy room link"
        className="inline-flex h-8 items-center gap-1.5 rounded-sc-full bg-sc-accent-soft px-3 t-label text-sc-accent-700 transition-[filter,background-color] duration-200 hover:brightness-95 disabled:opacity-40 disabled:pointer-events-none"
      >
        {copied ? (
          <Check size={14} weight="bold" />
        ) : (
          <Copy size={14} weight="bold" />
        )}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
