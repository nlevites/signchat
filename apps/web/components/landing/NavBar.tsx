"use client";

import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useTransform,
} from "motion/react";
import Link from "next/link";
import { useState } from "react";
import { Logo } from "@/components/ui/Logo";

export function NavBar() {
  const reduce = useReducedMotion();
  const { scrollY } = useScroll();
  const [hidden, setHidden] = useState(false);

  // glass over hero (transparent tint), solid bone after scroll
  const bg = useTransform(
    scrollY,
    [0, 120],
    ["rgba(255,255,255,0.08)", "rgba(255,255,255,0.92)"],
  );
  const borderColor = useTransform(
    scrollY,
    [0, 120],
    ["rgba(255,255,255,0.18)", "rgba(227,230,239,1)"],
  );
  const blur = useTransform(scrollY, [0, 120], ["blur(14px)", "blur(20px)"]);
  // logo cross-fade — overlay (full color) over hero, solid (gradient silhouette) on light
  const overlayOpacity = useTransform(scrollY, [40, 100], [1, 0]);
  const solidOpacity = useTransform(scrollY, [40, 100], [0, 1]);

  // auto-hide on scroll-down past 160px; show on scroll-up
  useMotionValueEvent(scrollY, "change", (latest) => {
    if (reduce) return;
    const prev = scrollY.getPrevious() ?? 0;
    const delta = latest - prev;
    if (latest > 160 && delta > 4) setHidden(true);
    else if (delta < -4) setHidden(false);
  });

  return (
    <motion.nav
      initial={false}
      animate={hidden ? { y: -140 } : { y: 0 }}
      transition={{ duration: 0.3, ease: "easeInOut" }}
      className="fixed top-0 left-0 right-0 z-50 px-3 pt-2"
    >
      <motion.div
        style={{ backgroundColor: bg, backdropFilter: blur, borderColor }}
        className="mx-auto flex h-[48px] max-w-[1280px] items-center justify-between overflow-visible rounded-sc-full border px-5"
      >
        <Link
          href="/"
          aria-label="Signchat home"
          className="relative inline-block translate-y-[10px]"
        >
          <motion.div style={{ opacity: solidOpacity }}>
            <Logo size={90} wordmarkSize={50} surface="solid" />
          </motion.div>
          <motion.div
            style={{ opacity: overlayOpacity }}
            className="absolute inset-0"
          >
            <Logo size={90} wordmarkSize={50} surface="overlay" />
          </motion.div>
        </Link>
        <Link
          href="/start"
          className="inline-flex items-center rounded-sc-full bg-sc-accent-soft px-3 py-1 t-label font-semibold text-sc-accent-700 transition-transform duration-150 hover:-translate-y-px"
        >
          Start a call
        </Link>
      </motion.div>
    </motion.nav>
  );
}
