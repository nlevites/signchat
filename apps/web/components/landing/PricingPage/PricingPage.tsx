import {
  ArrowRight,
  Broadcast,
  Check,
  ChatsCircle,
  GithubLogo,
  Heart,
  Lock,
  PaperPlaneTilt,
  Plus,
  Sparkle,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Reveal, RevealGroup } from "@/components/ui/Reveal";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./pricing-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing", "Contact"] as const;

interface FaqItem {
  q: string;
  a: React.ReactNode;
}

const FAQ: FaqItem[] = [
  {
    q: "Why is it free?",
    a: <>Because the people who need real-time ASL-to-voice the most are the least likely to have a budget for it. The whole product runs in your browser with no relay — there's no server to pay for and no per-call cost to pass on. The OSS version on <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a> is the same code we ship to enterprise customers.</>,
  },
  {
    q: "Do I need an account?",
    a: <>No. Open <a href="/start">signchat.org/start</a>, allow camera and mic, and you're in a call. We don't track you, we don't mint a user identifier, and we don't store transcripts.</>,
  },
  {
    q: "Where does my video go?",
    a: <>Nowhere we can see. Camera frames are processed locally by MediaPipe and our custom ASL classifier. Only the resulting tokens are sent — directly from your browser — to Gemini for sentence stitching and to ElevenLabs for voice synthesis. Signchat operates no relay.</>,
  },
  {
    q: "Can I self-host or fork it?",
    a: <>Yes. The web app, the Bridge desktop companion, the ASL classifier model, and the sign pipeline are all in the <a href={REPO_URL} target="_blank" rel="noreferrer">monorepo</a>. Bring your own OpenRouter and ElevenLabs keys (or swap them for your own inference endpoint) and you're done.</>,
  },
  {
    q: "What about schools and non-profits?",
    a: <>The free app already covers you, but if you want a written letter, sample lesson plans, or rollout help, see <a href="/education">Signchat for schools</a>. It's zero-cost.</>,
  },
  {
    q: "What does an enterprise contract add?",
    a: <>SSO/SAML, SCIM provisioning, a private deployment in your VPC, audit logs, and a contractual SLA with a named technical contact. The product itself is identical — see <a href="/enterprise">Signchat for Teams</a>.</>,
  },
];

export function PricingPage() {
  return (
    <>
      <div className={s.root}>
        <header className={s.header}>
          <div className={s.headerInner}>
            <Nav logo={<Logo size={84} wordmarkSize={37} surface="overlay" />} links={NAV_LINKS} />
          </div>
        </header>

        <section className={s.hero}>
          <div className={s.heroBg} aria-hidden>
            <video
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              poster="/hero-header/hero-bg-poster.webp"
            >
              <source src="/hero-header/hero-bg.mp4" type="video/mp4" />
            </video>
          </div>
          <RevealGroup className={s.heroInner}>
            <span className={s.eyebrow}>
              <span className={s.eyebrowDot} aria-hidden />
              Pricing
            </span>
            <h1 className={s.headline}>Free for everyone. Always.</h1>
            <p className={s.subheadline}>
              Signchat is open source and runs entirely in your browser. Use it for a video call
              with a friend, a class group project, or a company all-hands — same code, same price.
            </p>
          </RevealGroup>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Two ways to use it</span>
                <h2 className={s.sectionHeading}>Free forever, with an enterprise option when you need one.</h2>
                <p className={s.sectionLede}>
                  Most people only ever need the free app. Companies that want SSO, a private
                  deployment, and a humans-on-call relationship can layer Signchat for Teams on top
                  — same product, just governed.
                </p>
              </header>
              <div className={s.tiers}>
                <article className={`${s.tier} ${s.tierFeatured}`}>
                  <div className={s.tierBadgeRow}>
                    <h3 className={s.tierName}>Free / Open source</h3>
                    <span className={s.tierBadge}><Heart size={11} weight="fill" /> Most people</span>
                  </div>
                  <div className={s.tierPriceRow}>
                    <span className={s.tierPrice}>$0</span>
                    <span className={s.tierPriceUnit}>forever, no account</span>
                  </div>
                  <p className={s.tierLede}>
                    Every Signchat feature, in your browser, with no install. Bring your own API
                    keys for any usage-billed providers.
                  </p>
                  <ul className={s.tierBullets}>
                    {[
                      "Real-time sign-to-voice with the custom ASL classifier",
                      "Live captions of the hearing peer's side",
                      "Auto and proofread modes — you have the final word",
                      "Bridge desktop app for FaceTime, Zoom, Meet, Teams, Discord",
                      "Full source on GitHub — fork, audit, self-host",
                    ].map((b) => (
                      <li key={b}>
                        <span className={s.tierBulletDot} aria-hidden><Check size={11} weight="bold" /></span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  <div className={s.tierCtaRow}>
                    <a className={s.tierCtaPrimary} href="/start">
                      <PaperPlaneTilt size={16} weight="bold" />
                      Start a call
                    </a>
                    <a className={s.tierCtaSecondary} href={REPO_URL} target="_blank" rel="noreferrer">
                      <GithubLogo size={16} weight="fill" />
                      View source
                    </a>
                  </div>
                </article>

                <article className={s.tier}>
                  <div className={s.tierBadgeRow}>
                    <h3 className={s.tierName}>Enterprise</h3>
                    <span className={s.tierBadge}><Sparkle size={11} weight="fill" /> For organizations</span>
                  </div>
                  <div className={s.tierPriceRow}>
                    <span className={s.tierPrice}>Let's talk</span>
                  </div>
                  <p className={s.tierLede}>
                    The same product, with SSO, a private deployment, audit trails, and a
                    contractual SLA with a named contact.
                  </p>
                  <ul className={s.tierBullets}>
                    {[
                      "Everything in Free",
                      "SAML SSO and SCIM provisioning",
                      "On-prem or your VPC deployment",
                      "Audit logs and admin console",
                      "Dedicated support and accessibility-team reviews",
                    ].map((b) => (
                      <li key={b}>
                        <span className={s.tierBulletDot} aria-hidden><Check size={11} weight="bold" /></span>
                        <span>{b}</span>
                      </li>
                    ))}
                  </ul>
                  <div className={s.tierCtaRow}>
                    <a className={s.tierCtaPrimary} href="/enterprise">
                      <ChatsCircle size={16} weight="bold" />
                      Talk to us
                    </a>
                    <a className={s.tierCtaSecondary} href="/enterprise">
                      <ArrowRight size={16} weight="bold" />
                      See enterprise
                    </a>
                  </div>
                </article>
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>What "free" actually means</span>
                <h2 className={s.sectionHeading}>No fine print, no $0-then-paywall.</h2>
                <p className={s.sectionLede}>
                  Signchat doesn't run a relay or a paid tier of the product itself. The only costs
                  that exist are billed by the model vendors — and they're billed to your keys, not
                  to us.
                </p>
              </header>
              <div className={s.freeMeans}>
                <div className={s.freeMeansBlock}>
                  <span className={s.freeMeansLabel}><Lock size={11} weight="bold" /> What stays local</span>
                  <h3 className={s.freeMeansTitle}>Your camera and the ASL classifier</h3>
                  <p className={s.freeMeansBody}>
                    MediaPipe and our ONNX classifier run inside your browser tab. No frames leave
                    the device on the per-turn data path. See the{" "}
                    <a href={`${REPO_URL}/blob/main/ARCHITECTURE.md`} target="_blank" rel="noreferrer">
                      architecture doc
                    </a>{" "}
                    for the wire diagram.
                  </p>
                </div>
                <div className={s.freeMeansBlock}>
                  <span className={s.freeMeansLabel}><Broadcast size={11} weight="bold" /> What goes to providers</span>
                  <h3 className={s.freeMeansTitle}>Tokens to Gemini, audio from ElevenLabs</h3>
                  <p className={s.freeMeansBody}>
                    Recognized sign tokens go directly from your browser to Gemini for sentence
                    stitching, and to ElevenLabs for voice. Both are billed by those vendors
                    directly to your own keys — Signchat is not in the middle.
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>FAQ</span>
                <h2 className={s.sectionHeading}>Things people usually ask before their first call.</h2>
              </header>
              <ul className={s.faq}>
                {FAQ.map((item) => (
                  <li key={item.q}>
                    <details>
                      <summary>
                        <span>{item.q}</span>
                        <span className={s.faqMarker} aria-hidden>
                          <Plus size={14} weight="bold" />
                        </span>
                      </summary>
                      <div className={s.faqAnswer}>{item.a}</div>
                    </details>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <PaperPlaneTilt size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>Start a call. It's free.</h2>
              <p className={s.outroBody}>
                Open the app, allow camera and mic, share the room link. No account, no install —
                just talk.
              </p>
              <a className={s.outroCta} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Start a call
                <ArrowRight size={16} weight="bold" />
              </a>
            </Reveal>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}

export default PricingPage;
