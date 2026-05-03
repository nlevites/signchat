"use client";

import {
  Ear,
  HandWaving,
  VideoCameraSlash,
} from "@phosphor-icons/react/dist/ssr";
import type {
  LocalVideoTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
} from "livekit-client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { CaptionMessage, Role } from "@signchat/contracts";
import { useTranscriptStore } from "@/lib/stores";

// §6.2: caption stays pinned through the duration of TTS playback. 8 s covers
// the long tail of ElevenLabs Flash v2.5 turns; after that the caption hands
// off to the global TranscriptStrip below the cameras.
const DEAF_CAPTION_HOLD_MS = 8000;

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

  const captionsDegradedChip = useTranscriptStore(
    (s) =>
      s.captionsDegraded && tileRole === "hearing" && showHearingPartials,
  );

  // Re-tick once a second so the hold-window can expire without any external
  // nudge. Only runs while there's a candidate caption.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    if (!latestDeafCaption) return;
    setNowMs(Date.now());
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [latestDeafCaption]);

  const deafCaptionVisible =
    latestDeafCaption !== null &&
    nowMs > 0 &&
    nowMs < latestDeafCaption.playAtMs + DEAF_CAPTION_HOLD_MS;

  const showVideo = !!videoTrack;
  const showCameraOff = !empty && !showVideo;

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-sc-xl border border-sc-border bg-[var(--sc-hero-deep)] shadow-sc-md">
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
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center">
          <p className="t-h3 text-sc-text">
            {emptyText ?? "Waiting for the second participant…"}
          </p>
          <p className="t-body-sm text-sc-text-2">
            Share the room link to invite them.
          </p>
        </div>
      ) : null}
      {showCameraOff ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white/85">
          <VideoCameraSlash size={28} weight="fill" />
          <span className="t-body-sm">Camera off</span>
        </div>
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
      {hearingPartialText ? (
        <div
          aria-live="polite"
          className="absolute right-3 bottom-12 left-3 rounded-sc-md bg-black/65 px-3 py-1.5 text-balance text-white backdrop-blur"
        >
          <span className="t-body-sm line-clamp-2 leading-snug">
            {hearingPartialText}
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
    </div>
  );
}
