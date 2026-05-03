import {
  Check,
  HandWaving,
  Lightning,
  PaperPlaneRight,
  PencilSimple,
} from "@phosphor-icons/react/dist/ssr";
import type { CSSProperties } from "react";
import { CTAButton } from "./CTAButton";
import { Fireflies } from "./Fireflies";
import { GlassPanel } from "./GlassPanel";
import s from "./hero-header.module.css";

interface HeroProps {
  headline: string;
  subheadline: string;
  ctaLabel: string;
  ctaHref: string;
  videoSrc: string;
  posterSrc?: string;
  subjectSrc: string;
}

/* providers in the Signchat per-turn pipeline (architecture §3, §5, §6).
 * order matches the data flow: hand landmarks → tokens → sentence → voice
 * → SFU. each is rendered as a brand-coloured 24px svg via mask-image so
 * the agent rail reads as the actual stack, not invented "agents". */
const PROVIDERS = [
  { slug: "mediapipe",  vendor: "MediaPipe" },
  { slug: "onnx",       vendor: "ONNX Runtime" },
  { slug: "gemini",     vendor: "Gemini" },
  { slug: "elevenlabs", vendor: "ElevenLabs" },
  { slug: "livekit",    vendor: "LiveKit" },
] as const;

function providerLogoStyle(slug: string, size = 18): CSSProperties {
  const url = `url('/providers/${slug}.svg')`;
  return {
    display: "inline-block",
    width: size,
    height: size,
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskRepeat: "no-repeat",
    maskRepeat: "no-repeat",
    WebkitMaskPosition: "center",
    maskPosition: "center",
    WebkitMaskSize: "contain",
    maskSize: "contain",
    background: "rgba(255,255,255,0.92)",
  };
}

export function Hero({
  headline,
  subheadline,
  ctaLabel,
  ctaHref,
  videoSrc,
  posterSrc,
  subjectSrc,
}: HeroProps) {
  return (
    <section className={s.hero}>
      <div className={s.heroBg} aria-hidden>
        <video
          autoPlay
          muted
          loop
          playsInline
          poster={posterSrc}
          preload="metadata"
        >
          <source src={videoSrc} type="video/mp4" />
        </video>
      </div>

      {/* TODO: Replace with Signchat-licensed photograph (signer mid-sign,
          hands lifted, or video-call subject). Do NOT ship the placeholder
          file (./assets/hero-person-original.webp) to production. */}
      <figure className={s.heroSubject} aria-hidden>
        <img src={subjectSrc} alt="" decoding="async" />
      </figure>

      <Fireflies count={32} />

      <div className={s.titleGroup}>
        <h1 className={s.headline}>
          {headline.includes(",") ? (
            <>
              {headline.slice(0, headline.indexOf(",") + 1)}
              <br />
              {headline.slice(headline.indexOf(",") + 1).trimStart()}
            </>
          ) : (
            headline
          )}
        </h1>
        <p className={s.subheadline}>{subheadline}</p>
        <div className={s.ctaWrap}>
          <CTAButton href={ctaHref}>{ctaLabel}</CTAButton>
        </div>
      </div>

      <div className={s.panels} aria-hidden>
        {/* slot 1 — live ASL token stream from the in-browser classifier
            (architecture §5). PIZZA · ME · LIKE matches the demo script in
            the pitch PRD §4.2. */}
        <GlassPanel slot="chat" index={0} ariaLabel="Live ASL classifier">
          <div className={s.chatHeader}>
            <HandWaving size={14} weight="regular" style={{ opacity: 0.7 }} />
            <span>Custom ASL classifier · runs in browser</span>
          </div>
          <div className={s.chatBubble}>
            <span style={{ opacity: 0.7, fontSize: 12 }}>
              Top-k tokens from the last window
            </span>
            <div className={s.chatPills} style={{ marginTop: 8 }}>
              <span className={s.chatPill}>PIZZA · 0.91</span>
              <span className={s.chatPill}>ME · 0.78</span>
              <span className={s.chatPill}>LIKE · 0.84</span>
            </div>
          </div>
          <div className={s.chatBubble}>
            <span style={{ opacity: 0.7, fontSize: 12 }}>
              Two seconds of silence → stitch
            </span>
            <div style={{ marginTop: 6, fontSize: 14 }}>“I like pizza.”</div>
          </div>
          <div className={s.chatPills}>
            <span className={s.chatPill}>
              <Check size={11} weight="bold" /> Approve
            </span>
            <span className={s.chatPill}>
              <PencilSimple size={11} weight="bold" /> Edit
            </span>
          </div>
          <div className={s.chatInput}>
            <span>type instead — chat composer fallback</span>
            <span className={s.chatSend} aria-hidden>
              <PaperPlaneRight size={14} weight="fill" />
            </span>
          </div>
        </GlassPanel>

        {/* slot 2 — provider chain (architecture §1, §3). cycling label
            reveal animates each logo in turn (CSS-only, see module). */}
        <GlassPanel slot="agents" index={1} rounded ariaLabel="Signchat provider chain">
          <div className={s.agentRail}>
            {PROVIDERS.map(({ slug, vendor }) => (
              <span key={slug} className={s.agentDot} title={vendor}>
                <span aria-hidden style={providerLogoStyle(slug)} />
                <span className={s.agentLabel}>{vendor}</span>
              </span>
            ))}
          </div>
        </GlassPanel>

        {/* slot 3 — the headline latency claim from PRD §5.5. */}
        <GlassPanel slot="search" index={2} pill ariaLabel="End-to-end latency">
          <span className={s.pillIcon} aria-hidden>
            <Lightning size={12} weight="fill" />
          </span>
          <span>Sign-end to first audible byte · less than 1 s at P50</span>
        </GlassPanel>

        {/* slot 4 — review-before-broadcast UI (architecture §7, PRD §5.4
            secondary originality moment). */}
        <GlassPanel slot="editor" index={3} ariaLabel="Review before broadcast">
          <div className={s.editorTopBar}>
            <span>Review before broadcast</span>
            <span className={s.editorSpacer} />
            <span style={{ opacity: 0.6 }}>auto · 2.0 s silence</span>
          </div>
          <div className={s.editorTitle}>“I like pizza.”</div>
          <div className={s.editorBody}>
            <p style={{ opacity: 0.7, fontSize: 12, marginBottom: 8 }}>
              Stitched from your tokens by{" "}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  verticalAlign: "middle",
                }}
              >
                <span aria-hidden style={providerLogoStyle("gemini", 12)} />
                <span style={{ color: "#ffffff", fontWeight: 500 }}>Gemini</span>
              </span>
              . The other side hasn’t heard anything yet — you have the final say.
            </p>
            <div className={s.chatPills} style={{ margin: 0 }}>
              <span className={s.chatPill}>PIZZA</span>
              <span className={s.chatPill}>ME</span>
              <span className={s.chatPill}>LIKE</span>
            </div>
          </div>
          <div className={s.editorToolbar}>
            <span
              className={s.editorTool}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                width: "auto",
                height: "auto",
                padding: "6px 10px",
                background: "rgba(212,199,255,0.18)",
                color: "#ffffff",
              }}
            >
              <Check size={11} weight="bold" />
              <span>Approve</span>
            </span>
            <span
              className={s.editorTool}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                width: "auto",
                height: "auto",
                padding: "6px 10px",
              }}
            >
              <PencilSimple size={11} weight="bold" />
              <span>Edit</span>
            </span>
            <span className={s.editorSpacer} />
            <span style={{ fontSize: 11, opacity: 0.55 }}>↵ to send</span>
          </div>
        </GlassPanel>

        {/* slot 5 — single-turn provider hop summary. */}
        <GlassPanel slot="reply" index={4} pill ariaLabel="Browser-direct per-turn calls">
          <span className={s.pillIcon} aria-hidden>
            <Lightning size={12} weight="bold" />
          </span>
          <span>Browser-direct · no relay</span>
        </GlassPanel>

        {/* slot 6 — live captions on the Deaf tile (architecture §5.8, §6,
            PRD §4.2). high-level transcript only — no provider metadata
            and no debug numbers (those live in the editor + search slots). */}
        <GlassPanel slot="mail" index={5} ariaLabel="Live captions on the Deaf tile">
          <div className={s.mailHeader}>
            <span className={`${s.mailTab} ${s.mailTabActive}`}>
              Live captions
            </span>
            <span className={s.editorSpacer} />
            <span style={{ opacity: 0.6, fontSize: 11 }}>
              hearing peer · streaming
            </span>
          </div>
          <div className={s.mailRows}>
            <div className={`${s.mailRow} ${s.mailRowSelected}`}>
              <strong>Hearing peer</strong>
              <span>Okay, what kind?</span>
            </div>
            <div className={s.mailRow}>
              <strong>You</strong>
              <span>I like pizza.</span>
            </div>
            <div className={s.mailRow}>
              <strong>Hearing peer</strong>
              <span>Pepperoni or margherita?</span>
            </div>
            <div className={s.mailRow}>
              <strong>You</strong>
              <span>Pepperoni.</span>
            </div>
            <div className={s.mailRow}>
              <strong>Hearing peer</strong>
              <span>Coming up.</span>
            </div>
          </div>
        </GlassPanel>

        {/* slot 7 — Bridge electron app, the next step (architecture §16,
            PRD §2 row 4, §5.6). */}
        <GlassPanel slot="scheduler" index={6} ariaLabel="Bridge — route signchat-voice to FaceTime, Zoom, Meet">
          <span className={s.pillIcon} aria-hidden>
            <Lightning size={12} weight="fill" />
          </span>
          <div style={{ fontSize: 13, fontWeight: 460, lineHeight: 1.35 }}>
            Bridge → FaceTime · Zoom · Meet · Teams
          </div>
        </GlassPanel>
      </div>
    </section>
  );
}
