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
      className="relative min-h-screen w-full overflow-hidden"
    >
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(to left bottom, rgba(168,164,216,0.5), rgba(107,165,232,0.5), rgba(176,112,192,0.6), rgba(144,136,208,0.5)), linear-gradient(rgb(124,154,211), rgb(49,70,130))",
        }}
      />
      <div className="relative z-10 flex min-h-screen flex-col items-center pt-[140px] md:pt-[180px] px-24">
        <div className="flex flex-col items-center gap-32 max-w-[760px] w-full">
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
            className="text-display leading-display tracking-display font-w540 text-bone text-center"
          >
            Conversation,
            <br />
            without barriers.
          </motion.h1>
          <motion.p
            {...fadeSlideUp}
            transition={{ duration: 0.5, ease: "easeInOut", delay: 0.2 }}
            className="text-subheading leading-subheading tracking-subheading text-bone/85 text-center max-w-[560px]"
          >
            Real-time sign-to-voice video chat for deaf signers and hearing peers. Two browsers, no install, no interpreter.
          </motion.p>
          <motion.div
            {...fadeSlideUp}
            transition={{ duration: 0.5, ease: "easeInOut", delay: 0.3 }}
          >
            <CtaButton href="/room/test">Join a room</CtaButton>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
