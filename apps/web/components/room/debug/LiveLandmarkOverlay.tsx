"use client";

import {
  FaceLandmarker,
  HandLandmarker,
  PoseLandmarker,
} from "@mediapipe/tasks-vision";
import { useEffect, useRef } from "react";
import type { NormalizedLandmark } from "@signchat/runtime-browser/sign-pipeline/landmark-assembly";
import { useDebugSignalsStore } from "@/lib/stores";

interface Connection {
  start: number;
  end: number;
}

interface LiveLandmarkOverlayProps {
  /** Mirrors landmark x to match a horizontally-flipped local <video>. */
  mirror?: boolean;
}

const FACE_OVAL_LINE = "rgba(146, 148, 244, 0.55)";
const FACE_FEATURE_LINE = "rgba(176, 178, 252, 0.78)";
const FACE_IRIS_LINE = "rgba(212, 199, 255, 0.95)";
const FACE_LINE_WIDTH = 1.1;
const POSE_LINE = "rgba(168, 132, 229, 0.55)";
const POSE_DOT = "rgba(212, 199, 255, 0.85)";
const POSE_LINE_WIDTH = 2.2;
const LHAND_LINE = "rgba(255, 130, 165, 0.85)";
const LHAND_DOT = "#ffd0dc";
const RHAND_LINE = "rgba(104, 222, 255, 0.85)";
const RHAND_DOT = "#d4f3ff";
const HAND_LINE_WIDTH = 2.2;
const MIN_LINE_WIDTH = 1;

const FACE_FEATURE_GROUPS: ReadonlyArray<Connection[]> = [
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW,
  FaceLandmarker.FACE_LANDMARKS_LIPS,
];

/**
 * Renders the latest MediaPipe landmark frame from the deaf-side classifier
 * directly on top of the local video tile. Subscribes to
 * useDebugSignalsStore so it picks up frames whenever DeafSession is
 * running, regardless of which surface mounts the overlay. Sized to its
 * parent via ResizeObserver — assumes the parent is aspect-video matching
 * the source camera (1280x720 / 16:9), so no cover transform is needed.
 */
export function LiveLandmarkOverlay({
  mirror = false,
}: LiveLandmarkOverlayProps) {
  const frame = useDebugSignalsStore((s) => s.latestFrame);
  const result = useDebugSignalsStore((s) => s.latestResult);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Resize the canvas to fit the parent at devicePixelRatio. Tracks parent
  // bbox via ResizeObserver so the overlay reshapes when the PiP grows
  // across breakpoints.
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ro = new ResizeObserver(() => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const dpr = window.devicePixelRatio || 1;
      const targetW = Math.max(1, Math.floor(w * dpr));
      const targetH = Math.max(1, Math.floor(h * dpr));
      if (canvas.width !== targetW) canvas.width = targetW;
      if (canvas.height !== targetH) canvas.height = targetH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!frame) return;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

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
      // face mesh below already conveys the head and dot-stippling on top
      // of the mesh reads as visual noise.
      drawLandmarksFromIndex(ctx, frame.pose, 11, mirror, w, h, POSE_DOT, 2);
    }

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
      drawLandmarks(ctx, hand.landmarks, mirror, w, h, dotColor, 1.8);
      for (const tipIdx of [4, 8, 12, 16, 20]) {
        const lm = hand.landmarks[tipIdx];
        if (!lm) continue;
        drawDot(ctx, project(lm, mirror, w, h), 3, dotColor);
      }
    }
  }, [frame, mirror]);

  const top = result?.top?.[0];
  const topConfidence = top ? Math.round(top.score * 100) : null;

  return (
    <div
      ref={wrapRef}
      className="pointer-events-none absolute inset-0"
      aria-hidden
    >
      <canvas ref={canvasRef} className="absolute inset-0 size-full" />
      {top ? (
        <div className="absolute top-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-sc-full bg-black/70 px-2.5 py-1 text-[11px] font-medium text-white backdrop-blur">
          <span className="font-mono uppercase tracking-wider text-white/95">
            {top.label}
          </span>
          {topConfidence !== null ? (
            <span className="text-white/55">{topConfidence}%</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

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

function drawLandmarksFromIndex(
  ctx: CanvasRenderingContext2D,
  landmarks: ReadonlyArray<NormalizedLandmark>,
  startIndex: number,
  mirror: boolean,
  w: number,
  h: number,
  color: string,
  radius: number,
): void {
  ctx.fillStyle = color;
  for (let i = startIndex; i < landmarks.length; i += 1) {
    const lm = landmarks[i];
    if (!lm) continue;
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
