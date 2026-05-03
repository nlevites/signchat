"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import type { VisionFrame } from "@/lib/sign-pipeline/mediapipe-runner";

export interface CameraPreviewProps {
  /** MediaStream from getUserMedia, typically supplied by MediaPipeOnnxClassifier. */
  stream: MediaStream | null;
  /** Latest landmark frame; used to overlay dots. */
  frame: VisionFrame | null;
  /** Mirror the video horizontally. Defaults to true (selfie convention). */
  mirror?: boolean;
  className?: string;
}

const FACE_COLOR = "rgba(146, 148, 244, 0.55)";
const POSE_COLOR = "rgba(117, 120, 240, 0.85)";
const LHAND_COLOR = "rgba(23, 165, 115, 0.9)";
const RHAND_COLOR = "rgba(219, 79, 59, 0.9)";

export function CameraPreview({
  stream,
  frame,
  mirror = true,
  className,
}: CameraPreviewProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {
        // Autoplay can fail in some browsers; muted+playsInline usually wins.
      });
    } else {
      video.srcObject = null;
    }
  }, [stream]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (
      canvas.width !== video.clientWidth ||
      canvas.height !== video.clientHeight
    ) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.floor(video.clientWidth * dpr));
      canvas.height = Math.max(1, Math.floor(video.clientHeight * dpr));
      canvas.style.width = `${video.clientWidth}px`;
      canvas.style.height = `${video.clientHeight}px`;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!frame) return;
    const w = video.clientWidth;
    const h = video.clientHeight;

    // Face — only every 8th landmark to keep the canvas readable.
    if (frame.face) {
      ctx.fillStyle = FACE_COLOR;
      for (let i = 0; i < frame.face.length; i += 8) {
        const lm = frame.face[i];
        if (!lm) continue;
        const x = mirror ? (1 - lm.x) * w : lm.x * w;
        const y = lm.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 1.0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    if (frame.pose) {
      ctx.fillStyle = POSE_COLOR;
      for (const lm of frame.pose) {
        const x = mirror ? (1 - lm.x) * w : lm.x * w;
        const y = lm.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    for (const hand of frame.hands) {
      ctx.fillStyle = hand.handedness === "Left" ? LHAND_COLOR : RHAND_COLOR;
      for (const lm of hand.landmarks) {
        const x = mirror ? (1 - lm.x) * w : lm.x * w;
        const y = lm.y * h;
        ctx.beginPath();
        ctx.arc(x, y, 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }, [frame, mirror]);

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sc-xl border border-sc-border bg-[var(--sc-hero-deep)] shadow-sc-xs",
        className,
      )}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className="block w-full"
        style={mirror ? { transform: "scaleX(-1)" } : undefined}
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0"
      />
      {!stream ? (
        <div className="absolute inset-0 flex items-center justify-center t-body-sm text-white/75">
          camera not started
        </div>
      ) : null}
    </div>
  );
}
