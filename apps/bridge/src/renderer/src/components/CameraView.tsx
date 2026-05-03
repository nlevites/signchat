import { useEffect, useRef, type JSX } from "react";
import type { VisionFrame } from "@signchat/runtime-browser/sign-pipeline/mediapipe-runner";
import type { NormalizedLandmark } from "@signchat/runtime-browser/sign-pipeline/landmark-assembly";

interface Connection {
  start: number;
  end: number;
}

export interface CameraViewProps {
  stream: MediaStream | null;
  frame: VisionFrame | null;
  mirror?: boolean;
}

const POSE_LINE = "rgba(146, 148, 244, 0.85)";
const POSE_DOT = "rgba(180, 182, 250, 0.95)";
const FACE_LINE = "rgba(190, 192, 250, 0.85)";
const LHAND_LINE = "rgba(94, 222, 165, 0.92)";
const LHAND_DOT = "rgba(160, 245, 200, 1)";
const RHAND_LINE = "rgba(255, 144, 124, 0.92)";
const RHAND_DOT = "rgba(255, 190, 175, 1)";

const POSE_CONNECTIONS: Connection[] = [
  { start: 11, end: 13 },
  { start: 13, end: 15 },
  { start: 12, end: 14 },
  { start: 14, end: 16 },
  { start: 11, end: 12 },
  { start: 11, end: 23 },
  { start: 12, end: 24 },
  { start: 23, end: 24 },
];

const HAND_CONNECTIONS: Connection[] = [
  { start: 0, end: 1 },
  { start: 1, end: 2 },
  { start: 2, end: 3 },
  { start: 3, end: 4 },
  { start: 0, end: 5 },
  { start: 5, end: 6 },
  { start: 6, end: 7 },
  { start: 7, end: 8 },
  { start: 5, end: 9 },
  { start: 9, end: 10 },
  { start: 10, end: 11 },
  { start: 11, end: 12 },
  { start: 9, end: 13 },
  { start: 13, end: 14 },
  { start: 14, end: 15 },
  { start: 15, end: 16 },
  { start: 13, end: 17 },
  { start: 0, end: 17 },
  { start: 17, end: 18 },
  { start: 18, end: 19 },
  { start: 19, end: 20 },
];

export function CameraView({
  stream,
  frame,
  mirror = true,
}: CameraViewProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      video.play().catch(() => {
        // some browsers reject autoplay even with muted; loadeddata is enough
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

    if (frame.pose) {
      drawConnections(ctx, frame.pose, POSE_CONNECTIONS, mirror, w, h, POSE_LINE, 2);
      drawDots(ctx, frame.pose, mirror, w, h, POSE_DOT, 2);
    }
    if (frame.face) {
      // Draw a few face landmark dots for liveness; full mesh is overkill in
      // the small Bridge window.
      const sample = frame.face.filter((_, i) => i % 12 === 0);
      drawDots(ctx, sample, mirror, w, h, FACE_LINE, 1);
    }
    for (const hand of frame.hands) {
      const lineColor = hand.handedness === "Left" ? LHAND_LINE : RHAND_LINE;
      const dotColor = hand.handedness === "Left" ? LHAND_DOT : RHAND_DOT;
      drawConnections(
        ctx,
        hand.landmarks,
        HAND_CONNECTIONS,
        mirror,
        w,
        h,
        lineColor,
        1.5,
      );
      drawDots(ctx, hand.landmarks, mirror, w, h, dotColor, 2);
    }
  }, [frame, mirror]);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-zinc-800 bg-black shadow-inner">
      <video
        ref={videoRef}
        muted
        playsInline
        autoPlay
        className="block h-full w-full object-cover"
        style={mirror ? { transform: "scaleX(-1)" } : undefined}
      />
      <canvas
        ref={canvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
      />
      {!stream ? (
        <div className="absolute inset-0 flex items-center justify-center text-xs text-zinc-400">
          camera not started
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
  ctx.lineWidth = width;
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

function drawDots(
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
