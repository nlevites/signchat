"use client";

import { useEffect, useRef } from "react";
import s from "./hero-header.module.css";

type Firefly = {
  x: number;
  y: number;
  r: number;
  alpha: number;
  vy: number;
  freq: number;
  phase: number;
  amp: number;
};

interface FirefliesProps {
  count?: number;
}

function subjectEllipse(w: number, h: number) {
  let top = 350;
  let subH = 860;
  if (typeof window !== "undefined") {
    if (window.matchMedia("(max-width: 768px)").matches) {
      top = 320;
      subH = 420;
    } else if (window.matchMedia("(max-width: 1023px)").matches) {
      top = 320;
      subH = 540;
    }
  }
  subH = Math.min(subH, Math.max(100, h - top - 16));
  const cx = w * 0.5;
  const cy = top + subH * 0.46;
  const rx = Math.min(w * 0.48, Math.min(1152, w) * 0.52 + 48);
  const ry = subH * 0.64;
  return { cx, cy, rx, ry };
}

function randomInEllipse(cx: number, cy: number, rx: number, ry: number) {
  const u = Math.random() * Math.PI * 2;
  const rr = Math.sqrt(Math.random());
  return { x: cx + rr * rx * Math.cos(u), y: cy + rr * ry * Math.sin(u) };
}

function circleFullyInside(
  cx: number,
  cy: number,
  r: number,
  w: number,
  h: number,
): boolean {
  return cx - r >= 0 && cx + r <= w && cy - r >= 0 && cy + r <= h;
}

export function Fireflies({ count = 32 }: FirefliesProps) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.max(1, window.devicePixelRatio || 1);
    let w = 0;
    let h = 0;

    const flies: Firefly[] = [];

    const subjectBias = 0.74;

    const spawn = (anywhere: boolean): Firefly => {
      const r = 1.35 + Math.random() * 2.35;
      const amp = 3.5 + Math.random() * 5;
      const pad = r + amp + 1;

      const pickUniform = (): { x: number; y: number } => {
        const xSpan = Math.max(0, w - 2 * pad);
        const x = pad + (xSpan > 0 ? Math.random() * xSpan : w * 0.5);
        const ySpan = Math.max(0, h - 2 * pad);
        const y = pad + (ySpan > 0 ? Math.random() * ySpan : h * 0.5);
        return { x, y };
      };

      let x = w * 0.5;
      let y = h * 0.5;

      if (!anywhere) {
        const xSpan = Math.max(0, w - 2 * pad);
        x = pad + (xSpan > 0 ? Math.random() * xSpan : w * 0.5);
        if (Math.random() < subjectBias && xSpan > 0 && w > 120) {
          const ell = subjectEllipse(w, h);
          const spread = Math.min(ell.rx * 0.72, xSpan * 0.5);
          x = ell.cx + (Math.random() * 2 - 1) * spread;
          x = Math.min(Math.max(x, pad), w - pad);
        }
        y = h + pad + Math.random() * 72;
      } else {
        let placed = false;
        for (let attempt = 0; attempt < 18; attempt++) {
          if (Math.random() < subjectBias && w > 160 && h > 240) {
            const ell = subjectEllipse(w, h);
            const p = randomInEllipse(ell.cx, ell.cy, ell.rx, ell.ry);
            x = p.x;
            y = p.y;
          } else {
            const u = pickUniform();
            x = u.x;
            y = u.y;
          }
          if (x >= pad && x <= w - pad && y >= pad && y <= h - pad) {
            placed = true;
            break;
          }
        }
        if (!placed) {
          const u = pickUniform();
          x = u.x;
          y = u.y;
        }
      }

      return {
        x,
        y,
        r,
        alpha: 0.15 + Math.random() * 0.2,
        vy: 3.5 + Math.random() * 6,
        freq: 1 / (4 + Math.random() * 4),
        phase: Math.random() * Math.PI * 2,
        amp,
      };
    };

    const clampFlyX = (f: Firefly) => {
      const pad = f.r + f.amp + 1;
      const maxX = w - pad;
      if (maxX < pad) {
        f.x = w * 0.5;
        return;
      }
      f.x = Math.min(Math.max(f.x, pad), maxX);
    };

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = Math.max(1, rect.width);
      h = Math.max(1, rect.height);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      for (const f of flies) clampFlyX(f);
    };

    resize();

    while (flies.length < count) flies.push(spawn(true));

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let last = performance.now();
    let raf = 0;

    const step = (t: number) => {
      if (document.hidden) {
        last = t;
        raf = requestAnimationFrame(step);
        return;
      }
      const dt = Math.min(0.05, (t - last) / 1000);
      last = t;
      ctx.clearRect(0, 0, w, h);
      const padExit = 14;
      for (const f of flies) {
        f.y -= f.vy * dt;
        const jitter =
          Math.sin((t / 1000) * Math.PI * 2 * f.freq + f.phase) * f.amp;
        const cx = f.x + jitter;
        const cy = f.y;
        if (circleFullyInside(cx, cy, f.r, w, h)) {
          ctx.beginPath();
          ctx.arc(cx, cy, f.r, 0, Math.PI * 2);
          ctx.fillStyle = `rgba(255, 230, 180, ${f.alpha})`;
          ctx.fill();
        }
        if (f.y < -padExit) Object.assign(f, spawn(false));
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [count]);

  return <canvas ref={ref} className={s.fireflies} aria-hidden />;
}
