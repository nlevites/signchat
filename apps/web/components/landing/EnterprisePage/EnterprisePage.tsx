import {
  ArrowRight,
  Broadcast,
  ChatsCircle,
  CloudArrowUp,
  GithubLogo,
  Headset,
  Lock,
  ShieldCheck,
  UsersThree,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./enterprise-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
/* TODO: swap for the real Signchat enterprise inbox once provisioned. */
const CONTACT_EMAIL = "hello@signchat.org";
const CONTACT_HREF = `mailto:${CONTACT_EMAIL}?subject=Signchat%20for%20Teams%20pilot`;
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing"] as const;

interface Feature {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: <UsersThree size={20} weight="regular" />,
    title: "SSO and central admin",
    body: "Provision Signchat through SAML or Okta SCIM. Manage seats, audit access, and rotate revocations from one console — same browser-direct pipeline, now governed.",
  },
  {
    icon: <CloudArrowUp size={20} weight="regular" />,
    title: "On-prem or your VPC",
    body: "Run the same OSS pipeline behind your firewall. Bring your own OpenRouter and ElevenLabs keys, or point Bridge at a self-hosted inference endpoint with zero per-call relay.",
  },
  {
    icon: <Headset size={20} weight="regular" />,
    title: "Dedicated support and SLA",
    body: "A named contact for rollout, accessibility-team reviews, and priority engineering when a sign vocabulary or accent doesn't hit your bar.",
  },
];

interface ComplianceTag {
  label: string;
  icon?: React.ReactNode;
}

const COMPLIANCE_TAGS: ComplianceTag[] = [
  { label: "Browser-direct · no relay", icon: <Broadcast size={12} weight="bold" /> },
  { label: "Camera frames stay local",  icon: <Lock size={12} weight="bold" /> },
  { label: "BYO API keys",              icon: <ShieldCheck size={12} weight="bold" /> },
  { label: "Open-source audit trail" },
  { label: "SOC 2 on the roadmap" },
];

export function EnterprisePage() {
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
              For organizations
            </span>
            <h1 className={s.headline}>Bring Signchat to your whole company.</h1>
            <p className={s.subheadline}>
              Give every Deaf and Hard-of-Hearing teammate a real-time voice in every meeting —
              without scheduling an interpreter, installing a plugin, or routing audio through a
              third-party relay.
            </p>
            <div className={s.ctaRow}>
              <a className={s.ctaPrimary} href={CONTACT_HREF}>
                <ChatsCircle size={18} weight="bold" />
                Talk to us
              </a>
              <a className={s.ctaSecondary} href={REPO_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                Read the source
              </a>
            </div>

            <div className={s.proofStrip} aria-label="Why teams pick Signchat">
              <div className={s.proofItem}>
                <span className={s.proofValue}>&lt; 1s</span>
                <span className={s.proofCaption}>sign → voice (P50)</span>
              </div>
              <div className={s.proofItem}>
                <span className={s.proofValue}>0</span>
                <span className={s.proofCaption}>relay servers</span>
              </div>
              <div className={s.proofItem}>
                <span className={s.proofValue}>1:1</span>
                <span className={s.proofCaption}>or any meeting tool</span>
              </div>
              <div className={s.proofItem}>
                <span className={s.proofValue}>OSS</span>
                <span className={s.proofCaption}>same code as the free app</span>
              </div>
            </div>
          </div>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>What you get</span>
                <h2 className={s.sectionHeading}>The same browser-direct pipeline, made enterprise-ready.</h2>
                <p className={s.sectionLede}>
                  Signchat for Teams adds the controls procurement asks for — identity, deployment,
                  and a humans-on-call relationship — on top of the exact open-source product your
                  employees already love.
                </p>
              </header>
              <ul className={s.features}>
                {FEATURES.map((f) => (
                  <li key={f.title}>
                    <span className={s.featureIcon} aria-hidden>{f.icon}</span>
                    <h3 className={s.featureTitle}>{f.title}</h3>
                    <p className={s.featureBody}>{f.body}</p>
                  </li>
                ))}
              </ul>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Built on what's already free</span>
                <h2 className={s.sectionHeading}>Buy the relationship, not a different product.</h2>
                <p className={s.sectionLede}>
                  Every enterprise feature is layered onto the same MIT-licensed Signchat your team
                  can audit on GitHub today. There is no separate paid binary, no closed-source fork,
                  and nothing hidden behind a feature flag.
                </p>
              </header>
              <div className={s.builtOn}>
                <article className={s.builtOnCard}>
                  <span className={s.builtOnLabel}>Open source</span>
                  <h3 className={s.builtOnTitle}>signchat.org / GitHub</h3>
                  <p className={s.builtOnBody}>
                    The full sign-to-voice and live-captions pipeline, Bridge desktop companion,
                    and the custom ASL classifier — free, forever, no account.
                  </p>
                  <a className={s.builtOnLink} href={REPO_URL} target="_blank" rel="noreferrer">
                    View on GitHub <ArrowRight size={14} weight="bold" />
                  </a>
                </article>
                <article className={s.builtOnCard}>
                  <span className={s.builtOnLabel}>Enterprise</span>
                  <h3 className={s.builtOnTitle}>Signchat for Teams</h3>
                  <p className={s.builtOnBody}>
                    Everything in the free app, plus SSO, a private deployment, a named technical
                    contact, and a contractual SLA. Paid by the seat, billed annually.
                  </p>
                  <a className={s.builtOnLink} href={CONTACT_HREF}>
                    Email the team <ArrowRight size={14} weight="bold" />
                  </a>
                </article>
              </div>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Compliance &amp; privacy</span>
                <h2 className={s.sectionHeading}>Zero-relay by architecture, not by promise.</h2>
                <p className={s.sectionLede}>
                  Camera frames stay on the device. Per-turn calls go directly from the browser to
                  the providers your security team approves. We can't see your meetings — and we'll
                  happily walk your team through the source proving it.
                </p>
              </header>
              <div className={s.compliance}>
                <span className={s.complianceIcon} aria-hidden>
                  <ShieldCheck size={22} weight="regular" />
                </span>
                <div className={s.complianceBody}>
                  <h3 className={s.complianceTitle}>How the data path works</h3>
                  <ul className={s.complianceList}>
                    {COMPLIANCE_TAGS.map((tag) => (
                      <li key={tag.label}>
                        {tag.icon ?? null}
                        {tag.label}
                      </li>
                    ))}
                  </ul>
                  <p style={{ margin: 0, fontSize: 14, lineHeight: 1.55, color: "#4a4558" }}>
                    The browser captures hand landmarks with MediaPipe, runs our ONNX classifier
                    locally, and only ships the resulting tokens to Gemini for sentence stitching
                    and to ElevenLabs for voice — both on your keys, both on your contracts.
                  </p>
                </div>
              </div>
            </div>

            <div className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <UsersThree size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>Pilot Signchat with your team.</h2>
              <p className={s.outroBody}>
                Tell us a little about your company and the meeting tools your team lives in.
                We'll come back within a business day with a rollout plan and a price.
              </p>
              <a className={s.outroCta} href={CONTACT_HREF}>
                <ChatsCircle size={18} weight="bold" />
                Email {CONTACT_EMAIL}
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

export default EnterprisePage;
