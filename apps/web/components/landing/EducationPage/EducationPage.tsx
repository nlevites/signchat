import {
  ArrowRight,
  Books,
  ChalkboardTeacher,
  ChatsCircle,
  GraduationCap,
  Heart,
  Student,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Reveal, RevealGroup } from "@/components/ui/Reveal";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./education-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const CONTACT_HREF = "/contact";
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing", "Contact"] as const;

interface Program {
  icon: React.ReactNode;
  title: string;
  body: string;
  audience: string;
}

const PROGRAMS: Program[] = [
  {
    icon: <Student size={20} weight="regular" />,
    title: "K–12 districts",
    body: "Pair Deaf students with hearing peers in any class without an interpreter on the schedule. Signchat runs in the same browser tabs your students already open for class.",
    audience: "for accessibility coordinators",
  },
  {
    icon: <GraduationCap size={20} weight="regular" />,
    title: "Universities and colleges",
    body: "Disability services teams can roll out Signchat for office hours, study groups, and TA sessions in minutes — no IT install, no per-seat negotiation.",
    audience: "for disability services",
  },
  {
    icon: <Books size={20} weight="regular" />,
    title: "Deaf studies & ITP programs",
    body: "Use the live ASL classifier and review-before-broadcast UI as a teaching tool. Students see exactly which signs the model caught and where it guessed.",
    audience: "for instructors & researchers",
  },
];

interface Integration {
  slug: string;
  name: string;
  note: string;
}

const INTEGRATIONS: Integration[] = [
  { slug: "zoom",  name: "Zoom for Education", note: "drop in via Bridge" },
  { slug: "meet",  name: "Google Meet",        note: "Workspace for Education" },
  { slug: "teams", name: "Microsoft Teams",    note: "EDU tenants supported" },
];

export function EducationPage() {
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
              For educators
            </span>
            <h1 className={s.headline}>Every classroom deserves a voice.</h1>
            <p className={s.subheadline}>
              Deaf and Hard-of-Hearing students shouldn't have to wait days for an interpreter to be
              scheduled. Signchat turns any laptop camera into real-time ASL-to-voice and live
              captions — so participation starts the second class does.
            </p>
            <div className={s.ctaRow}>
              <a className={s.ctaPrimary} href={CONTACT_HREF}>
                <ChatsCircle size={18} weight="bold" />
                Bring it to your school
              </a>
              <a className={s.ctaSecondary} href="/start">
                <ArrowRight size={18} weight="bold" />
                Try it in a browser
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>Free for accredited schools</span>
              <span>No installs, no accounts</span>
              <span>Open source</span>
            </div>
          </RevealGroup>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Programs we support</span>
                <h2 className={s.sectionHeading}>From kindergarten to graduate seminars.</h2>
                <p className={s.sectionLede}>
                  Signchat is purpose-built for the conversations education doesn't schedule weeks
                  in advance — group projects, lab partners, after-class questions, the kinds of
                  moments where an interpreter just isn't in the room.
                </p>
              </header>
              <div className={s.programs}>
                {PROGRAMS.map((p) => (
                  <article key={p.title} className={s.programCard}>
                    <span className={s.programIcon} aria-hidden>{p.icon}</span>
                    <h3 className={s.programTitle}>{p.title}</h3>
                    <p className={s.programBody}>{p.body}</p>
                    <span className={s.programAudience}>{p.audience}</span>
                  </article>
                ))}
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Free for schools</span>
                <h2 className={s.sectionHeading}>Always free for accredited schools and 501(c)(3) non-profits.</h2>
                <p className={s.sectionLede}>
                  The web app is free for everyone, forever. For institutions that need a written
                  letter, light onboarding, or help wiring up Bridge across a lab, just say hi —
                  no procurement loop required.
                </p>
              </header>
              <div className={s.freeBand}>
                <span className={s.freeIcon} aria-hidden>
                  <Heart size={24} weight="regular" />
                </span>
                <div className={s.freeBody}>
                  <h3 className={s.freeTitle}>Send us your .edu details</h3>
                  <p className={s.freeText}>
                    Drop a message on LinkedIn and we'll send a one-page rollout guide, a sample
                    lesson plan from Deaf-studies instructors, and a direct line if anything sticks.
                  </p>
                </div>
                <a className={s.freeCta} href={CONTACT_HREF}>
                  Get the educator pack <ArrowRight size={14} weight="bold" />
                </a>
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Classroom integrations</span>
                <h2 className={s.sectionHeading}>Drops into the meeting tools your school already pays for.</h2>
                <p className={s.sectionLede}>
                  Signchat works in any modern browser today. With{" "}
                  <a href="/bridge" style={{ color: "#714cb6", textDecoration: "none", borderBottom: "1px solid currentColor" }}>
                    Bridge
                  </a>
                  , the same audio graph becomes a system microphone you can pick inside any video
                  tool — no admin policy changes, no classroom rewiring.
                </p>
              </header>
              <div className={s.integrationsRail}>
                {INTEGRATIONS.map((i) => (
                  <div key={i.slug} className={s.integrationTile}>
                    <span className={s.integrationLogo} aria-hidden>
                      <img src={`/integrations/${i.slug}.svg`} alt="" />
                    </span>
                    <div className={s.integrationText}>
                      <span className={s.integrationName}>{i.name}</span>
                      <span className={s.integrationNote}>{i.note}</span>
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <ChalkboardTeacher size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>Bring Signchat to your school.</h2>
              <p className={s.outroBody}>
                Tell us about your program and the tools your students use. We'll send back a
                rollout plan and a free institutional license — usually within a school day.
              </p>
              <a className={s.outroCta} href={CONTACT_HREF}>
                <ChatsCircle size={18} weight="bold" />
                Get in touch
                <ArrowRight size={16} weight="bold" />
              </a>
              <a href={REPO_URL} target="_blank" rel="noreferrer" style={{ marginTop: 4, fontSize: 13, color: "#7d7789", textDecoration: "none" }}>
                Or fork the code on GitHub →
              </a>
            </Reveal>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}

export default EducationPage;
