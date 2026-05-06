import {
  ArrowRight,
  Broadcast,
  DownloadSimple,
  GithubLogo,
  HandWaving,
  PlugsConnected,
  ShieldCheck,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Reveal, RevealGroup } from "@/components/ui/Reveal";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./bridge-page.module.css";

const RELEASES_URL = "https://github.com/nlevites/signchat/releases";
const REPO_URL = "https://github.com/nlevites/signchat";
const BLACKHOLE_URL = "https://existential.audio/blackhole/";
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing", "Contact"] as const;

interface Feature {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const FEATURES: Feature[] = [
  {
    icon: <PlugsConnected size={20} weight="regular" />,
    title: "System-level virtual mic",
    body:
      "Bridge mixes your synthesised voice into a BlackHole virtual microphone so any video tool that picks a mic can use Signchat — no SDK or extension needed.",
  },
  {
    icon: <Broadcast size={20} weight="regular" />,
    title: "Same browser-direct path",
    body:
      "Bridge runs the identical OpenRouter and ElevenLabs pipeline as the web app. No new backend, no relay — your sign tokens stitch and stream straight from the desktop renderer.",
  },
  {
    icon: <HandWaving size={20} weight="regular" />,
    title: "Drop into any 1:1 call",
    body:
      "Pick the Bridge mic in FaceTime, Zoom, Google Meet, Teams, or Discord. Live captions of the call come back through a BlackHole loopback so you read what they say in real time.",
  },
];

interface RequirementStep {
  title: string;
  detail: React.ReactNode;
}

const REQUIREMENTS: RequirementStep[] = [
  {
    title: "macOS 13 or newer",
    detail: (
      <>
        Apple Silicon (arm64) and Intel (x64) are both supported. Bridge is
        signed and notarised; double-click the DMG and drag it to{" "}
        <code>Applications</code>.
      </>
    ),
  },
  {
    title: "BlackHole 2ch and 16ch",
    detail: (
      <>
        Bridge plays its synthesised voice into <strong>BlackHole 2ch</strong>{" "}
        (the virtual mic Zoom subscribes to) and reads the call back through{" "}
        <strong>BlackHole 16ch</strong> for live captions. Install both from{" "}
        <a href={BLACKHOLE_URL} target="_blank" rel="noreferrer">
          existential.audio/blackhole
        </a>
        .
      </>
    ),
  },
  {
    title: "A Multi-Output Device named Bridge Loopback",
    detail: (
      <>
        Open <strong>Audio MIDI Setup</strong>, click <strong>+</strong> →{" "}
        <strong>Create Multi-Output Device</strong>, and check both your
        normal speakers / headphones and <strong>BlackHole 16ch</strong>. Name
        it <code>Bridge Loopback</code>. In your video tool, pick that device
        as the <em>speaker</em> output so Bridge can transcribe what the other
        side says.
      </>
    ),
  },
  {
    title: "Camera and microphone permissions",
    detail: (
      <>
        Bridge asks for camera access (to capture your signing for MediaPipe
        and the ASL classifier) and microphone access (to read the BlackHole
        loopback). Both are local-only — no audio or video leaves your
        machine on the per-turn data path.
      </>
    ),
  },
];

export function BridgePage() {
  return (
    <>
      <div className={s.root}>
        <header className={s.header}>
          <div className={s.headerInner}>
            <Nav
              logo={<Logo size={84} wordmarkSize={37} surface="overlay" />}
              links={NAV_LINKS}
            />
          </div>
        </header>

        <section className={s.hero}>
          <div className={s.heroBg} aria-hidden>
            <video autoPlay muted loop playsInline preload="metadata">
              <source src="/hero-header/hero-bg.mp4" type="video/mp4" />
            </video>
          </div>
          <RevealGroup className={s.heroInner}>
            <span className={s.eyebrow}>
              <span className={s.eyebrowDot} aria-hidden />
              Available now · macOS
            </span>
            <h1 className={s.headline}>Your voice in every call.</h1>
            <p className={s.subheadline}>
              Sign Chat Bridge is a desktop companion that pipes the same
              Signchat audio graph into a system-level virtual microphone.
              Open FaceTime, Zoom, Meet, Teams, or Discord, pick the Bridge
              mic, and your signs become spoken sentences in any 1:1
              conversation.
            </p>
            <div className={s.ctaRow}>
              <a
                className={s.ctaPrimary}
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadSimple size={18} weight="bold" />
                Download for macOS
              </a>
              <a
                className={s.ctaSecondary}
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
              >
                <GithubLogo size={18} weight="fill" />
                View on GitHub
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>Apple Silicon &amp; Intel</span>
              <span>Notarised DMG</span>
              <span>Same OpenRouter + ElevenLabs path as web</span>
            </div>
          </RevealGroup>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>What it is</span>
                <h2 className={s.sectionHeading}>
                  The Signchat audio graph, routed as a microphone.
                </h2>
                <p className={s.sectionLede}>
                  Bridge wraps the same browser pipeline you already use at{" "}
                  <a
                    href="/start"
                    style={{
                      color: "#714cb6",
                      textDecoration: "none",
                      borderBottom: "1px solid currentColor",
                    }}
                  >
                    signchat.org
                  </a>{" "}
                  inside an Electron desktop app, then publishes its
                  synthesised voice as a system-level mic. There&rsquo;s no
                  new backend, no relay, and no per-call setup beyond picking
                  the right device once.
                </p>
              </header>
              <ul className={s.features}>
                {FEATURES.map((f) => (
                  <li key={f.title}>
                    <span className={s.featureIcon} aria-hidden>
                      {f.icon}
                    </span>
                    <h3 className={s.featureTitle}>{f.title}</h3>
                    <p className={s.featureBody}>{f.body}</p>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>What you need</span>
                <h2 className={s.sectionHeading}>
                  Four-minute setup, then drop into any video tool.
                </h2>
                <p className={s.sectionLede}>
                  Bridge ships as a notarised DMG and walks you through the
                  device picker the first time you launch it. The one-time
                  prerequisites live below.
                </p>
              </header>
              <ol className={s.steps}>
                {REQUIREMENTS.map((step, idx) => (
                  <li key={step.title}>
                    <span className={s.stepNumber} aria-hidden>
                      {idx + 1}
                    </span>
                    <div className={s.stepBody}>
                      <h3 className={s.stepTitle}>{step.title}</h3>
                      <p className={s.stepDetail}>{step.detail}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </Reveal>

            <Reveal className={s.outro}>
              <span
                aria-hidden
                style={{
                  display: "inline-grid",
                  placeItems: "center",
                  width: 44,
                  height: 44,
                  borderRadius: 10,
                  background: "#d4c7ff",
                  color: "#714cb6",
                }}
              >
                <ShieldCheck size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>
                Ready to bring Signchat into FaceTime?
              </h2>
              <p className={s.outroBody}>
                Bridge is open source, free, and runs entirely on your
                machine. The latest DMG is on GitHub Releases.
              </p>
              <a
                className={s.outroCta}
                href={RELEASES_URL}
                target="_blank"
                rel="noreferrer"
              >
                <DownloadSimple size={18} weight="bold" />
                Download Bridge
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

export default BridgePage;
