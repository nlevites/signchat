import {
  ArrowRight,
  ChatsCircle,
  GithubLogo,
  LinkedinLogo,
  PaperPlaneTilt,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Reveal, RevealGroup } from "@/components/ui/Reveal";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./contact-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing", "Contact"] as const;

interface Person {
  initial: string;
  name: string;
  role: string;
  blurb: string;
  linkedin: string;
  accent: string;
}

const ADIL: Person = {
  initial: "A",
  name: "Adil Bazarkulov",
  role: "Co-creator · Frontend & video-call integration",
  blurb:
    "Built the frontend and the video-call integration. Best contact for anything UI, room flow, or call support.",
  linkedin: "https://www.linkedin.com/in/bazarkua/",
  accent: "linear-gradient(135deg, #b196ff 0%, #714cb6 100%)",
};

const NATHAN: Person = {
  initial: "N",
  name: "Nathan Levites",
  role: "Co-creator · Classifier & backend",
  blurb:
    "Trained the ASL classifier and built much of the backend. Best contact for the model, the pipeline internals, and anything server-side.",
  linkedin: "https://www.linkedin.com/in/nathan-levites/",
  accent: "linear-gradient(135deg, #87b4ff 0%, #3a52a8 100%)",
};

const PEOPLE: Person[] = [ADIL, NATHAN];

export function ContactPage() {
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
              Get in touch
            </span>
            <h1 className={s.headline}>Talk to the people who built it.</h1>
            <p className={s.subheadline}>
              Signchat is a two-person project. The fastest way to reach us is LinkedIn — pick
              whichever of us is closest to your question and send a message. We read everything.
            </p>
            <div className={s.ctaRow}>
              <a
                className={s.ctaPrimary}
                href={ADIL.linkedin}
                target="_blank"
                rel="noreferrer"
              >
                <LinkedinLogo size={18} weight="fill" />
                Message Adil
              </a>
              <a
                className={s.ctaPrimary}
                href={NATHAN.linkedin}
                target="_blank"
                rel="noreferrer"
              >
                <LinkedinLogo size={18} weight="fill" />
                Message Nathan
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>LinkedIn replies usually inside a business day</span>
              <span>Or open an issue on GitHub</span>
            </div>
          </RevealGroup>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Who you'll talk to</span>
                <h2 className={s.sectionHeading}>The two of us, in order of relevance.</h2>
                <p className={s.sectionLede}>
                  No support inbox, no triage layer — when you message, you message us. If we're
                  the wrong person, we'll loop the other one in.
                </p>
              </header>
              <div className={s.people}>
                {PEOPLE.map((person) => (
                  <article key={person.name} className={s.personCard}>
                    <span
                      className={s.personAvatar}
                      style={{ background: person.accent }}
                      aria-hidden
                    >
                      {person.initial}
                    </span>
                    <div className={s.personMeta}>
                      <h3 className={s.personName}>{person.name}</h3>
                      <span className={s.personRole}>{person.role}</span>
                    </div>
                    <p className={s.personBody}>{person.blurb}</p>
                    <a
                      className={s.personCta}
                      href={person.linkedin}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <LinkedinLogo size={16} weight="fill" />
                      Send a message on LinkedIn
                      <ArrowRight size={14} weight="bold" />
                    </a>
                  </article>
                ))}
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Or somewhere more public</span>
                <h2 className={s.sectionHeading}>If your question is the kind that helps others.</h2>
                <p className={s.sectionLede}>
                  Bug reports, architecture questions, and feature requests are best filed as
                  GitHub issues so the answer lives in a place future readers can find it.
                </p>
              </header>
              <div className={s.publicGrid}>
                <a
                  className={s.publicCard}
                  href={`${REPO_URL}/issues/new`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={s.publicIcon} aria-hidden>
                    <GithubLogo size={20} weight="fill" />
                  </span>
                  <h3 className={s.publicTitle}>Open a GitHub issue</h3>
                  <p className={s.publicBody}>
                    Bugs, feature requests, and architecture questions. Tag with the area
                    (web, classifier, bridge) so the right one of us sees it first.
                  </p>
                  <span className={s.publicLink}>
                    File an issue <ArrowRight size={14} weight="bold" />
                  </span>
                </a>
                <a
                  className={s.publicCard}
                  href={REPO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className={s.publicIcon} aria-hidden>
                    <GithubLogo size={20} weight="fill" />
                  </span>
                  <h3 className={s.publicTitle}>Read the source</h3>
                  <p className={s.publicBody}>
                    Browse the monorepo for the web app, Bridge desktop companion, ASL classifier,
                    and the sign pipeline. MIT-licensed, every commit on main.
                  </p>
                  <span className={s.publicLink}>
                    View on GitHub <ArrowRight size={14} weight="bold" />
                  </span>
                </a>
              </div>
            </Reveal>

            <Reveal className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <ChatsCircle size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>The product is the fastest reply.</h2>
              <p className={s.outroBody}>
                If you haven't tried Signchat yet, opening a call takes less time than reading
                this page. No account, no install — just allow camera and mic.
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

export default ContactPage;
