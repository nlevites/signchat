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
import { useEffect, useRef } from "react";
import type { Role } from "@signchat/contracts";

interface VideoTileProps {
  label?: string;
  role?: Role | null;
  videoTrack?: LocalVideoTrack | RemoteVideoTrack | null;
  audioTrack?: RemoteAudioTrack | null;
  audioOutputDeviceId?: string;
  mirrored?: boolean;
  empty?: boolean;
  emptyText?: string;
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
