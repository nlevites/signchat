"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import {
  ArrowRight,
  Broadcast,
  Check,
  ChatText,
  HandWaving,
  PlugsConnected,
} from "@phosphor-icons/react/dist/ssr";
import s from "./signchat-suite.module.css";

interface SuiteTab {
  slug: string;
  label: string;
  icon: ReactNode;
  largeIcon: ReactNode;
  headline: string;
  body: string;
  bullets: string[];
  learnMore: string;
  learnMoreHref: string;
  visual: ReactNode;
}

const TABS: SuiteTab[] = [
  {
    slug: "sign-to-voice",
    label: "Sign to voice",
    icon: <HandWaving size={18} weight="regular" />,
    largeIcon: <HandWaving size={108} weight="regular" />,
    headline: "Sign with your hands. They hear your voice.",
    body:
      "Your camera feeds a 250-class ASL classifier running locally in your browser. Recognized signs are stitched into a real sentence by Gemini, streamed back as natural synthetic speech, and mixed with your real microphone into one stable voice channel. To the other person, it just sounds like you talking.",
    bullets: [
      "250-class ASL classifier runs locally — your camera feed never leaves your machine",
      "Sign-end to first audible byte: about 1.1 seconds at p50",
      "Synthetic speech mixed with your real mic on one persistent voice track",
      "No interpreter, no install, no account",
    ],
    learnMore: "How sign-to-voice works",
    learnMoreHref: "#sign-to-voice",
    visual: (
      <div className={s.visualSignToVoice}>
        <div className={s.tokenRow}>
          <span className={s.token}>PIZZA</span>
          <span className={s.tokenDot}>·</span>
          <span className={s.token}>ME</span>
          <span className={s.tokenDot}>·</span>
          <span className={s.token}>LIKE</span>
        </div>
        <div className={s.flowArrow}>
          <span />
          <span />
          <span />
        </div>
        <div className={s.sentenceCard}>
          <span className={s.sentenceQuote}>&ldquo;</span>
          I like pizza.
          <span className={s.sentenceQuote}>&rdquo;</span>
        </div>
        <div className={s.waveStrip} aria-hidden>
          {Array.from({ length: 28 }).map((_, i) => (
            <span
              key={i}
              style={{ height: `${20 + Math.abs(Math.sin(i * 0.7)) * 36}px` }}
            />
          ))}
        </div>
      </div>
    ),
  },
  {
    slug: "live-captions",
    label: "Live captions",
    icon: <ChatText size={18} weight="regular" />,
    largeIcon: <ChatText size={108} weight="regular" />,
    headline: "Their voice, captioned in under a second.",
    body:
      "Whisper and Silero VAD run on your machine, transcribing the hearing user's voice into streaming partials that appear word-by-word on their tile. Finals lock into the transcript strip below. Their audio never leaves your browser before becoming text.",
    bullets: [
      "Word-by-word streaming partials at about 1 second p50",
      "Whisper and Silero VAD pre-warmed in the lobby — no cold start",
      "Audio decoded locally and never sent to a third-party speech service",
      "Finals lock into a global transcript strip you can scroll back through",
    ],
    learnMore: "How captions work",
    learnMoreHref: "#live-captions",
    visual: (
      <div className={s.visualCaptions}>
        <div className={s.captionTile}>
          <div className={s.captionTileLabel}>
            <span className={s.captionLiveDot} />
            <span>Hearing user · live</span>
          </div>
          <div className={s.captionStream}>
            <span className={s.captionWordOld}>so I was thinking we should</span>{" "}
            <span className={s.captionWordNew}>order</span>
            <span className={s.captionCursor} aria-hidden />
          </div>
        </div>
        <div className={s.captionFinalRow}>
          <span className={s.captionFinalChip}>final</span>
          <span className={s.captionFinalText}>
            &ldquo;Yeah, let&rsquo;s do that — pizza sounds good.&rdquo;
          </span>
        </div>
      </div>
    ),
  },
  {
    slug: "review-before-broadcast",
    label: "Review before broadcast",
    icon: <Check size={18} weight="regular" />,
    largeIcon: <Check size={108} weight="regular" />,
    headline: "Approve every sentence before they hear it.",
    body:
      "When you stop signing, the reconstructed sentence slides in for review. Approve it, edit a typo, re-sign if the model misread, or discard. The other person never hears a half-formed turn — silence is cleaner than a wrong sentence.",
    bullets: [
      "Approve, Edit, Re-sign, or Discard — the signer always has the last word",
      "Edit inline with a textarea seeded by the model's output",
      "Auto mode ships on silence; Manual mode waits for Stop",
      "Errors stay loud — no fallback voice fakes a failed turn",
    ],
    learnMore: "Why we review before TTS",
    learnMoreHref: "#review-before-broadcast",
    visual: (
      <div className={s.visualReview}>
        <div className={s.previewLabel}>
          <Check size={12} weight="bold" />
          <span>Preview before broadcast</span>
          <span className={s.previewMode}>auto · 2.0 s silence</span>
        </div>
        <div className={s.previewSentence}>
          &ldquo;I like pizza.&rdquo;
        </div>
        <div className={s.previewMeta}>
          Stitched from your tokens by Gemini. The other side hasn&rsquo;t heard
          anything yet.
        </div>
        <div className={s.previewActions}>
          <span className={`${s.previewBtn} ${s.previewBtnPrimary}`}>
            Approve
          </span>
          <span className={s.previewBtn}>Edit</span>
          <span className={s.previewBtn}>Re-sign</span>
          <span className={s.previewBtn}>Discard</span>
        </div>
      </div>
    ),
  },
  {
    slug: "bridge",
    label: "Bridge · soon",
    icon: <PlugsConnected size={18} weight="regular" />,
    largeIcon: <PlugsConnected size={108} weight="regular" />,
    headline: "Soon: your voice in FaceTime, Zoom, and Meet.",
    body:
      "Bridge is a desktop companion that routes the same Signchat audio graph into a system-level virtual microphone. Open any video tool you already use, pick the Bridge mic, and your signs become spoken sentences in any 1:1 conversation.",
    bullets: [
      "macOS (BlackHole) and Windows (VB-CABLE) virtual mic targets",
      "Same browser-direct OpenRouter and ElevenLabs path — no new backend",
      "Drop into FaceTime, Zoom, Google Meet, Teams, or Discord",
      "Forward-compatible by design — not in the BeaverHacks 2026 submission",
    ],
    learnMore: "Bridge roadmap",
    learnMoreHref: "#bridge",
    visual: (
      <div className={s.visualBridge}>
        <div className={s.bridgeTargets}>
          {["FaceTime", "Zoom", "Meet", "Teams", "Discord"].map((app) => (
            <span key={app} className={s.bridgeApp}>
              {app}
            </span>
          ))}
        </div>
        <div className={s.bridgePipe} aria-hidden>
          <span className={s.bridgePipeLine} />
          <span className={s.bridgePipeNode}>
            <Broadcast size={18} weight="regular" />
          </span>
          <span className={s.bridgePipeLine} />
        </div>
        <div className={s.bridgeDevice}>
          <span className={s.bridgeDeviceLabel}>signchat-voice</span>
          <span className={s.bridgeDeviceMeta}>routed as system mic</span>
        </div>
      </div>
    ),
  },
];

export function SignchatSuite() {
  const [activeSlug, setActiveSlug] = useState(TABS[0]!.slug);
  const tab = TABS.find((t) => t.slug === activeSlug) ?? TABS[0]!;

  return (
    <section className={s.suite} aria-label="Start a call">
      <div className={s.inner}>
        <header className={s.head}>
          <h2 className={s.heading}>Start a call</h2>
          <a className={s.headCta} href="/start">
            Sign to Chat
            <ArrowRight size={14} weight="bold" />
          </a>
        </header>

        <div className={s.tabs} role="tablist" aria-label="Capabilities">
          {TABS.map((t) => {
            const active = t.slug === activeSlug;
            return (
              <button
                key={t.slug}
                type="button"
                role="tab"
                aria-selected={active}
                aria-controls={`suite-panel-${t.slug}`}
                className={`${s.tab} ${active ? s.tabActive : ""}`}
                onClick={() => setActiveSlug(t.slug)}
              >
                <span className={s.tabIcon}>{t.icon}</span>
                <span className={s.tabLabel}>{t.label}</span>
              </button>
            );
          })}
        </div>

        <div className={s.cardFrame}>
          <article
            className={s.card}
            id={`suite-panel-${tab.slug}`}
            role="tabpanel"
            aria-labelledby={tab.slug}
          >
            <div className={s.cardLeft}>
              <div className={s.cardLeftLabel}>
                <span className={s.tabIcon}>{tab.icon}</span>
                <span>{tab.label}</span>
              </div>
              <h3 className={s.cardHeadline}>{tab.headline}</h3>
              <p className={s.cardBody}>{tab.body}</p>
              <a className={s.learnMore} href={tab.learnMoreHref}>
                {tab.learnMore}
                <ArrowRight size={14} weight="bold" />
              </a>
              <ul className={s.bullets}>
                {tab.bullets.map((b) => (
                  <li key={b}>
                    <span className={s.bulletDot} aria-hidden>
                      <Check size={11} weight="bold" />
                    </span>
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className={s.cardRight}>
              <div className={s.visualBg} aria-hidden />
              <div className={s.visualBigIcon} aria-hidden>
                {tab.largeIcon}
              </div>
              <div className={s.visualForeground}>{tab.visual}</div>
            </div>
          </article>
        </div>
      </div>
    </section>
  );
}

export default SignchatSuite;
