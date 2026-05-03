"use client";

import { motion, useReducedMotion } from "motion/react";
import { Logo } from "@/components/ui/Logo";
import { CtaButton } from "@/components/ui/CtaButton";

export function Hero() {
  const reduce = useReducedMotion();

  const fadeSlideDown = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: -12 }, animate: { opacity: 1, y: 0 } };

  const fadeSlideUp = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } };

  return (
    <section
      id="join"
      className="sc-hero-field relative w-full pt-[140px] pb-24 md:pt-[180px] md:pb-40"
    >
      <div className="mx-auto flex w-full max-w-[760px] flex-col items-center gap-8 px-6">
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.94, y: -8 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.6, ease: "easeInOut" }}
        >
          <Logo size={140} wordmarkSize={84} surface="overlay" glow />
        </motion.div>
        <motion.h1
          {...fadeSlideDown}
          transition={{ duration: 0.5, ease: "easeInOut", delay: 0.1 }}
          className="t-display text-center text-white"
        >
          Conversation,
          <br />
          without barriers.
        </motion.h1>
        <motion.p
          {...fadeSlideUp}
          transition={{ duration: 0.5, ease: "easeInOut", delay: 0.2 }}
          className="t-body max-w-[560px] text-center text-white/80"
        >
          Real-time sign-to-voice video chat for deaf signers and hearing peers.
          Two browsers, no install, no interpreter.
        </motion.p>
        <motion.div
          {...fadeSlideUp}
          transition={{ duration: 0.5, ease: "easeInOut", delay: 0.3 }}
        >
          <CtaButton href="/start">Start a call</CtaButton>
        </motion.div>
      </div>
    </section>
  );
}
