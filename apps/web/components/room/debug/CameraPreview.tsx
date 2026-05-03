"use client";

import { useEffect, useRef } from "react";
import {
  FaceLandmarker,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";

// `Connection` is declared internally by @mediapipe/tasks-vision but not
// re-exported. The shape is stable: { start: number; end: number }.
interface Connection {
  start: number;
  end: number;
}
import { cn } from "@/lib/cn";
import type { NormalizedLandmark } from "@signchat/runtime-browser/sign-pipeline/landmark-assembly";
import type { VisionFrame } from "@signchat/runtime-browser/sign-pipeline/mediapipe-runner";

export interface CameraPreviewProps {
  /** MediaStream from getUserMedia, typically supplied by MediaPipeOnnxClassifier. */
  stream: MediaStream | null;
  /** Latest landmark frame; used to overlay dots + skeleton lines. */
  frame: VisionFrame | null;
  /** Mirror the video horizontally. Defaults to true (selfie convention). */
  mirror?: boolean;
  className?: string;
}

// All hex colors are the apps/web accent palette tinted for visibility on
// dark video. Lines use rgba so the overlay stays glanceable without
// hiding the underlying video.
const POSE_LINE = "rgba(146, 148, 244, 0.85)";
const POSE_DOT = "rgba(180, 182, 250, 0.95)";
const FACE_OVAL_LINE = "rgba(146, 148, 244, 0.55)";
const FACE_FEATURE_LINE = "rgba(190, 192, 250, 0.85)";
const FACE_IRIS_LINE = "rgba(160, 240, 230, 0.95)";
const LHAND_LINE = "rgba(94, 222, 165, 0.92)";
const LHAND_DOT = "rgba(160, 245, 200, 1)";
const RHAND_LINE = "rgba(255, 144, 124, 0.92)";
const RHAND_DOT = "rgba(255, 190, 175, 1)";

const MIN_LINE_WIDTH = 1.25;
const POSE_LINE_WIDTH = 2.5;
const HAND_LINE_WIDTH = 2;
const FACE_LINE_WIDTH = 1.25;

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

    const w = video.clientWidth;
    const h = video.clientHeight;
    if (w === 0 || h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.max(1, Math.floor(w * dpr));
    const targetH = Math.max(1, Math.floor(h * dpr));
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!frame) return;

    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    // Pose: skeleton lines + joint dots. Drawn first so face/hands sit on top.
    if (frame.pose) {
      drawConnections(
        ctx,
        frame.pose,
        PoseLandmarker.POSE_CONNECTIONS,
        mirror,
        w,
        h,
        POSE_LINE,
        POSE_LINE_WIDTH,
      );
      // Skip pose indices 0-10 (head/face area) when drawing dots — the
      // face mesh already conveys the head and dot-stippling on top of
      // the mesh reads as visual noise.
      for (let i = 11; i < frame.pose.length; i += 1) {
        const lm = frame.pose[i];
        if (!lm) continue;
        drawDot(ctx, project(lm, mirror, w, h), 3, POSE_DOT);
      }
    }

    // Face: oval + features (eyes, eyebrows, lips, irises). Skip tesselation
    // (drawing 2670+ tiny triangles makes the camera unreadable). The
    // contour groups give a clean, readable skeleton of the face.
    if (frame.face) {
      drawConnections(
        ctx,
        frame.face,
        FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
        mirror,
        w,
        h,
        FACE_OVAL_LINE,
        FACE_LINE_WIDTH,
      );
      for (const group of FACE_FEATURE_GROUPS) {
        drawConnections(
          ctx,
          frame.face,
          group,
          mirror,
          w,
          h,
          FACE_FEATURE_LINE,
          FACE_LINE_WIDTH,
        );
      }
      drawConnections(
        ctx,
        frame.face,
        FaceLandmarker.FACE_LANDMARKS_LEFT_IRIS,
        mirror,
        w,
        h,
        FACE_IRIS_LINE,
        FACE_LINE_WIDTH,
      );
      drawConnections(
        ctx,
        frame.face,
        FaceLandmarker.FACE_LANDMARKS_RIGHT_IRIS,
        mirror,
        w,
        h,
        FACE_IRIS_LINE,
        FACE_LINE_WIDTH,
      );
    }

    // Hands: skeleton + fingertip-emphasized dots. Drawn on top so they're
    // never occluded by the face/pose layers.
    for (const hand of frame.hands) {
      const lineColor = hand.handedness === "Left" ? LHAND_LINE : RHAND_LINE;
      const dotColor = hand.handedness === "Left" ? LHAND_DOT : RHAND_DOT;
      drawConnections(
        ctx,
        hand.landmarks,
        HandLandmarker.HAND_CONNECTIONS,
        mirror,
        w,
        h,
        lineColor,
        HAND_LINE_WIDTH,
      );
      drawLandmarks(ctx, hand.landmarks, mirror, w, h, dotColor, 2.5);
      // Emphasize fingertips (indices 4, 8, 12, 16, 20).
      for (const tipIdx of [4, 8, 12, 16, 20]) {
        const lm = hand.landmarks[tipIdx];
        if (!lm) continue;
        drawDot(ctx, project(lm, mirror, w, h), 4, dotColor);
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

const FACE_FEATURE_GROUPS: ReadonlyArray<Connection[]> = [
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
  FaceLandmarker.FACE_LANDMARKS_LIPS,
];

interface Point {
  x: number;
  y: number;
}

function project(
  lm: NormalizedLandmark,
  mirror: boolean,
  w: number,
  h: number,
): Point {
  return { x: mirror ? (1 - lm.x) * w : lm.x * w, y: lm.y * h };
}

function drawConnections(
  ctx: CanvasRenderingContext2D,
  landmarks: ReadonlyArray<NormalizedLandmark>,
  connections: ReadonlyArray<Connection>,
  mirror: boolean,
  w: number,
  h: number,
  color: string,
  width: number,
): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(MIN_LINE_WIDTH, width);
  ctx.beginPath();
  for (const c of connections) {
    const a = landmarks[c.start];
    const b = landmarks[c.end];
    if (!a || !b) continue;
    const pa = project(a, mirror, w, h);
    const pb = project(b, mirror, w, h);
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
  }
  ctx.stroke();
}

function drawLandmarks(
  ctx: CanvasRenderingContext2D,
  landmarks: ReadonlyArray<NormalizedLandmark>,
  mirror: boolean,
  w: number,
  h: number,
  color: string,
  radius: number,
): void {
  ctx.fillStyle = color;
  for (const lm of landmarks) {
    const p = project(lm, mirror, w, h);
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  p: Point,
  radius: number,
  color: string,
): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
  ctx.fill();
}
