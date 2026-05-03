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

  const bg = useTransform(
    scrollY,
    [0, 120],
    ["rgba(255,255,255,0.08)", "rgba(255,255,255,0.92)"],
  );
  const borderColor = useTransform(
    scrollY,
    [0, 120],
    ["rgba(255,255,255,0.18)", "rgba(227,227,226,1)"],
  );
  const blur = useTransform(scrollY, [0, 120], ["blur(14px)", "blur(20px)"]);
  const overlayOpacity = useTransform(scrollY, [40, 100], [1, 0]);
  const solidOpacity = useTransform(scrollY, [40, 100], [0, 1]);

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
      className="fixed top-0 left-0 right-0 z-50 px-12 pt-8"
    >
      <motion.div
        style={{ backgroundColor: bg, backdropFilter: blur, borderColor }}
        className="mx-auto max-w-[1280px] h-[48px] flex items-center justify-between rounded-pill border px-20 overflow-visible"
      >
        <Link
          href="/"
          aria-label="Signchat home"
          className="relative inline-block"
        >
          <motion.div style={{ opacity: solidOpacity }}>
            <Logo size={40} wordmarkSize={22} surface="solid" />
          </motion.div>
          <motion.div
            style={{ opacity: overlayOpacity }}
            className="absolute inset-0"
          >
            <Logo size={40} wordmarkSize={22} surface="overlay" />
          </motion.div>
        </Link>
        <Link
          href="#join"
          className="inline-flex items-center rounded-pill bg-lavender-chip px-12 py-4 text-body-sm font-semibold text-ink transition-transform duration-150 hover:-translate-y-px"
        >
          Join a room
        </Link>
      </motion.div>
    </motion.nav>
  );
}
