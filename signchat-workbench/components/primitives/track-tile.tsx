"use client";

import { useEffect, useRef } from "react";
import {
  ConnectionQuality,
  type Participant,
  type Track,
  type TrackPublication,
} from "livekit-client";
import type { Role } from "@/lib/contracts";

/**
 * Single participant tile — attaches the first video + audio publication of
 * the given Participant to a `<video>` and `<audio>` element. Cleans up
 * tracks on unmount and on every `rev` change (which is bumped by the
 * RoomStore when the participant emits any track / metadata event).
 *
 * For the local tile, callers should pass `mirrored` and `mute` so the
 * preview reads naturally and there's no mic feedback through the speakers.
 */

export interface TrackTileProps {
  participant: Participant;
  /** Display label override; defaults to participant.identity. */
  label?: string;
  /** "deaf" | "hearing" — rendered as a chip. */
  role?: Role | null;
  /** Mirror the video horizontally (use for the local camera). */
  mirrored?: boolean;
  /** Mute the audio element (use for the local tile to avoid feedback). */
  mute?: boolean;
  /**
   * Increment to force re-attachment when the participant's underlying
   * track set has changed. Driven by RoomStore's per-participant rev.
   */
  rev?: number;
  /** "you" badge in the corner. */
  isLocal?: boolean;
}

const QUALITY_PALETTE: Record<string, string> = {
  [ConnectionQuality.Excellent]: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  [ConnectionQuality.Good]: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  [ConnectionQuality.Poor]: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  [ConnectionQuality.Lost]: "border-rose-500/40 bg-rose-500/10 text-rose-200",
  [ConnectionQuality.Unknown]: "border-slate-600 bg-slate-700/30 text-slate-300",
};

const ROLE_PALETTE: Record<Role, string> = {
  deaf: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200",
  hearing: "border-cyan-500/40 bg-cyan-500/10 text-cyan-200",
};

export function TrackTile({
  participant,
  label,
  role,
  mirrored = false,
  mute = false,
  rev = 0,
  isLocal = false,
}: TrackTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    const audioEl = audioRef.current;
    if (!videoEl || !audioEl) return;

    const attached: Array<{
      track: Track;
      element: HTMLMediaElement;
    }> = [];

    for (const pub of participant.videoTrackPublications.values()) {
      const t = pub.track;
      if (t) {
        try {
          t.attach(videoEl);
          attached.push({ track: t, element: videoEl });
        } catch (err) {
          console.warn("[track-tile] video attach failed", err);
        }
      }
    }
    for (const pub of participant.audioTrackPublications.values()) {
      const t = pub.track;
      if (t) {
        try {
          t.attach(audioEl);
          attached.push({ track: t, element: audioEl });
        } catch (err) {
          console.warn("[track-tile] audio attach failed", err);
        }
      }
    }

    return () => {
      for (const { track, element } of attached) {
        try {
          track.detach(element);
        } catch {
          // best-effort
        }
      }
    };
  }, [participant, rev]);

  const displayLabel = label ?? participant.identity;
  const quality = participant.connectionQuality;
  const qualityClass =
    QUALITY_PALETTE[quality] ?? QUALITY_PALETTE[ConnectionQuality.Unknown] ?? "";
  const roleClass = role ? ROLE_PALETTE[role] : "";

  const audioPubs = collectAudio(participant);
  const videoPubs = collectVideo(participant);
  const hasVideo = videoPubs.some((p) => Boolean(p.track) && !p.isMuted);
  const hasAudio = audioPubs.some((p) => Boolean(p.track) && !p.isMuted);

  return (
    <div className="overflow-hidden rounded-xl border border-slate-700 bg-slate-900/70">
      <div className="relative aspect-video w-full bg-slate-950">
        <video
          ref={videoRef}
          className={`h-full w-full object-cover ${
            mirrored ? "[transform:scaleX(-1)]" : ""
          }`}
          autoPlay
          playsInline
          muted
        />
        <audio ref={audioRef} autoPlay muted={mute} />
        {!hasVideo ? (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">
            no video track
          </div>
        ) : null}
        {isLocal ? (
          <span className="absolute left-2 top-2 rounded border border-slate-700 bg-slate-900/80 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-200">
            you
          </span>
        ) : null}
        <span
          className={`absolute right-2 top-2 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${qualityClass}`}
          title="connection quality"
        >
          {quality}
        </span>
      </div>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-slate-200">{displayLabel}</span>
          {role ? (
            <span
              className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${roleClass}`}
            >
              {role}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-slate-400">
          <Badge active={hasAudio} label="aud" />
          <Badge active={hasVideo} label="vid" />
        </div>
      </div>
    </div>
  );
}

function Badge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={`rounded border px-1 py-0.5 font-mono text-[10px] tabular-nums ${
        active
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          : "border-slate-600 bg-slate-800/40 text-slate-500"
      }`}
    >
      {label}
    </span>
  );
}

function collectAudio(participant: Participant): TrackPublication[] {
  return Array.from(participant.audioTrackPublications.values());
}

function collectVideo(participant: Participant): TrackPublication[] {
  return Array.from(participant.videoTrackPublications.values());
}
