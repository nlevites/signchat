import {
  ArrowRight,
  ArrowUpRight,
  Broadcast,
  GithubLogo,
  Lightning,
  PaperPlaneTilt,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./architecture-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const ARCH_URL = `${REPO_URL}/blob/main/ARCHITECTURE.md`;
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing"] as const;

interface Stat { value: string; label: string; }
const STATS: Stat[] = [
  { value: "p50 ~0.6 s", label: "sign-end → first audible byte" },
  { value: "0",          label: "Signchat-operated relays" },
  { value: "17",         label: "documented sections" },
  { value: "MIT",        label: "open source" },
];

interface Section {
  num: string;
  title: string;
  blurb: string;
  slug: string;
}
const SECTIONS: Section[] = [
  { num: "1",  title: "Overview",                       blurb: "What Signchat is, the latency target, and what each provider does on the per-turn path.", slug: "1-overview" },
  { num: "2",  title: "Goals and non-goals",            blurb: "What's in scope for the MVP and what's intentionally deferred (Bridge, group calls, fallbacks).", slug: "2-goals-and-non-goals" },
  { num: "3",  title: "System diagram",                 blurb: "A mermaid flowchart of every actor on the per-turn path. Renders inline on GitHub.", slug: "3-system-diagram" },
  { num: "4",  title: "Repository layout",              blurb: "Tour of apps/, packages/, and the supporting Python and prompt-tester services.", slug: "4-repository-layout" },
  { num: "5",  title: "Service inventory",              blurb: "Twelve subsections covering web, transport, classifier, captions, mode controller, audio mixing.", slug: "5-service-inventory" },
  { num: "6",  title: "Live captions and transcript",   blurb: "Word-by-word partials for the hearing tile and full sentences for the deaf tile, with reliability guarantees.", slug: "6-live-captions-and-transcript-alignment" },
  { num: "7",  title: "Reliability and failure modes",  blurb: "What fails loudly, what retries, and why there are no fallback voices.", slug: "7-reliability-and-failure-modes" },
  { num: "8",  title: "Audio pipeline — signchat-voice",blurb: "Web Audio graph, LiveKit publish flags, tab-visibility behaviour for the synthesised mic.", slug: "8-audio-pipeline--signchat-voice" },
  { num: "9",  title: "Mode controller and capture",    blurb: "The capture state machine, configurable knobs, buffer-admit logic, inline preview UX.", slug: "9-mode-controller-and-capture-flow" },
  { num: "10", title: "API contracts — Vercel routes",  blurb: "Four credential-mint endpoints (LiveKit token, OpenRouter session key, ElevenLabs URL, health).", slug: "10-api-contracts--vercel-rest-routes" },
  { num: "11", title: "Browser-direct provider contracts", blurb: "OpenRouter chat completions, ElevenLabs streaming WSS, sign-pipeline and DataChannel contracts.", slug: "11-browser-direct-provider-contracts" },
  { num: "12", title: "Environment variables",          blurb: "Why there are no NEXT_PUBLIC_* variables — the browser never sees a root API key.", slug: "12-environment-variables" },
  { num: "13", title: "Performance budgets",            blurb: "Per-stage budgets that add up to the p50 ~0.6 s / p95 ~0.9 s end-to-end target.", slug: "13-performance-budgets" },
  { num: "14", title: "Security model",                 blurb: "What each party can see, threat models for secret leakage and provider abuse, mitigations.", slug: "14-security-model" },
  { num: "15", title: "Deployment topology",            blurb: "What Vercel hosts (and explicitly does not host), per-route runtime, deploy workflow.", slug: "15-deployment-topology" },
  { num: "16", title: "Bridge forward-compatibility",   blurb: "How the Electron desktop app reuses the same browser pipeline as a system-level mic.", slug: "16-bridge-forward-compatibility" },
  { num: "17", title: "Acceptance criteria",            blurb: "The hard checks the implementation has to pass — latency, no-relay invariants, security.", slug: "17-acceptance-criteria" },
];

interface Claim { icon: React.ReactNode; title: string; body: string; sourceLabel: string; sourceHref: string; }
const CLAIMS: Claim[] = [
  { icon: <Lightning size={18} weight="fill" />, title: "Sign-end to first audible byte: p50 ~0.6 s", body: "End-to-end latency budget broken down per stage in §13. Adds up to ~600 ms p50, ~900 ms p95.", sourceLabel: "ARCHITECTURE.md §13", sourceHref: `${ARCH_URL}#13-performance-budgets` },
  { icon: <Broadcast size={18} weight="regular" />, title: "Browser-direct, by architecture", body: "LiveKit Cloud, OpenRouter, and ElevenLabs handle every per-turn data path. Vercel is not on it. There is no Signchat-operated relay.", sourceLabel: "ARCHITECTURE.md §1, §15.3", sourceHref: `${ARCH_URL}#15-deployment-topology` },
  { icon: <Warning size={18} weight="regular" />, title: "No fallbacks, by choice", body: "A turn either succeeds through the primary path or surfaces a clear error. Errors stay loud — no fallback voice fakes a failed turn.", sourceLabel: "ARCHITECTURE.md (header)", sourceHref: ARCH_URL },
  { icon: <ShieldCheck size={18} weight="regular" />, title: "No NEXT_PUBLIC_* secrets", body: "The browser never sees a root API key. Per-room credentials are minted by short-lived Vercel routes; provider keys are session-scoped and credit-capped.", sourceLabel: "ARCHITECTURE.md §12, §14", sourceHref: `${ARCH_URL}#14-security-model` },
];

export function ArchitecturePage() {
  return (
    <>
      <div className={s.root}>
        <header className={s.header}>
          <div className={s.headerInner}>
            <Nav logo={<Logo size={84} wordmarkSize={37} surface="overlay" />} links={NAV_LINKS} />
          </div>
        </header>

        <section className={s.hero}>
          <div className={s.heroInner}>
            <span className={s.eyebrow}>
              <span className={s.eyebrowDot} aria-hidden />
              Architecture
            </span>
            <h1 className={s.headline}>How Signchat actually works.</h1>
            <p className={s.subheadline}>
              Sign-end to first audible byte: p50 ~0.6 s, p95 ~0.9 s. No fallbacks. No per-turn
              relay operated by Signchat. The authoritative spec lives in{" "}
              <code>ARCHITECTURE.md</code> on GitHub — this page is a guided index into it.
            </p>
            <div className={s.ctaRow}>
              <a className={s.ctaPrimary} href={ARCH_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                Read the full doc
              </a>
              <a className={s.ctaSecondary} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Try it in a browser
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>17 sections</span>
              <span>3 mermaid diagrams</span>
              <span>Updated with the code</span>
            </div>
          </div>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>At a glance</span>
                <h2 className={s.sectionHeading}>The numbers that matter.</h2>
              </header>
              <div className={s.statStrip}>
                {STATS.map((stat) => (
                  <div key={stat.label} className={s.statCard}>
                    <span className={s.statValue}>{stat.value}</span>
                    <span className={s.statLabel}>{stat.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>The data flow</span>
                <h2 className={s.sectionHeading}>Two browsers, three providers, one Vercel mint route.</h2>
                <p className={s.sectionLede}>
                  Everything below is summarized from{" "}
                  <a href={`${ARCH_URL}#1-overview`} target="_blank" rel="noreferrer" style={{ color: "#714cb6", textDecoration: "none", borderBottom: "1px solid currentColor" }}>§1 Overview</a>{" "}
                  and{" "}
                  <a href={`${ARCH_URL}#3-system-diagram`} target="_blank" rel="noreferrer" style={{ color: "#714cb6", textDecoration: "none", borderBottom: "1px solid currentColor" }}>§3 System diagram</a>.
                  If anything here disagrees with the doc, the doc wins.
                </p>
              </header>
              <div className={s.flow}>
                <p className={s.flowParagraph}>
                  <strong>Signing direction.</strong> The Deaf user&rsquo;s browser captures
                  landmarks with MediaPipe Tasks Vision, classifies them with an{" "}
                  <code>onnxruntime-web</code> model, and admits stable tokens into a buffer. On
                  sentence boundaries the browser POSTs tokens plus hearing context directly to
                  OpenRouter, gets a JSON <code>{"{ sentence, … }"}</code> back, and streams it to
                  ElevenLabs Flash v2.5 over a WebSocket. Returned 24&nbsp;kHz PCM is mixed with
                  the user&rsquo;s mic in Web Audio and published as a single LiveKit{" "}
                  <code>signchat-voice</code> track.
                </p>
                <p className={s.flowParagraph}>
                  <strong>Captions direction.</strong> The same Deaf browser subscribes to the
                  hearing user&rsquo;s audio, streams it to ElevenLabs voice-to-text, and forwards
                  partials and finals on the LiveKit data channel so both tiles render the same
                  captions in real time. Word-by-word partials in under a second; finals lock into
                  a global transcript strip.
                </p>
                <p className={s.flowParagraph}>
                  <strong>What Vercel does (and does not) do.</strong> Vercel hosts the marketing
                  pages, the room UI, and four short-lived credential-mint endpoints. There is no
                  server-side LiveKit bot, no TTS relay, no WSS gateway. Per{" "}
                  <a href={`${ARCH_URL}#15-deployment-topology`} target="_blank" rel="noreferrer">§15.3</a>,
                  Vercel is not on the per-turn data path.
                </p>
              </div>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Section index</span>
                <h2 className={s.sectionHeading}>Jump straight into the doc.</h2>
                <p className={s.sectionLede}>
                  Each link opens the matching heading in the GitHub rendering of{" "}
                  <code>ARCHITECTURE.md</code> (mermaid diagrams render inline there).
                </p>
              </header>
              <ol className={s.tocGrid}>
                {SECTIONS.map((sec) => (
                  <li key={sec.num}>
                    <a className={s.tocItem} href={`${ARCH_URL}#${sec.slug}`} target="_blank" rel="noreferrer">
                      <span className={s.tocNumber} aria-hidden>§{sec.num}</span>
                      <span className={s.tocBody}>
                        <span className={s.tocTitle}>{sec.title}</span>
                        <span className={s.tocBlurb}>{sec.blurb}</span>
                      </span>
                      <span className={s.tocArrow} aria-hidden><ArrowUpRight size={16} weight="bold" /></span>
                    </a>
                  </li>
                ))}
              </ol>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Key claims</span>
                <h2 className={s.sectionHeading}>Four things the architecture is willing to commit to.</h2>
                <p className={s.sectionLede}>
                  These are the load-bearing claims behind the product. Each one points at the
                  section of the doc that defines and defends it.
                </p>
              </header>
              <div className={s.claimGrid}>
                {CLAIMS.map((claim) => (
                  <article key={claim.title} className={s.claimCard}>
                    <span className={s.claimIcon} aria-hidden>{claim.icon}</span>
                    <h3 className={s.claimTitle}>{claim.title}</h3>
                    <p className={s.claimBody}>{claim.body}</p>
                    <p className={s.claimSource}><a href={claim.sourceHref} target="_blank" rel="noreferrer">{claim.sourceLabel} ↗</a></p>
                  </article>
                ))}
              </div>
            </div>

            <div className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <GithubLogo size={22} weight="fill" />
              </span>
              <h2 className={s.outroHeading}>Read the full architecture doc.</h2>
              <p className={s.outroBody}>
                The canonical spec is checked in next to the code and evolves with it. If you spot
                a mismatch between this page and the doc, file an issue — the doc is the source
                of truth.
              </p>
              <a className={s.outroCta} href={ARCH_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                Open ARCHITECTURE.md
                <ArrowRight size={16} weight="bold" />
              </a>
            </div>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}

export default ArchitecturePage;
