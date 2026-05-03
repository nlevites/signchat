import { Logo } from "@/components/ui/Logo";
import { Banner } from "./Banner";
import { Hero } from "./Hero";
import { Nav } from "./Nav";
import s from "./hero-header.module.css";

/* ---- copy + asset constants — edit here, not in JSX ----------------- */
const BANNER_TEXT = "Looking for Signchat for Teams?";
const BANNER_CTA = "Learn more";
const BANNER_HREF = "/teams";
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing"] as const;
/* H1 is rendered with a hard break after the comma to match the reference
 * (two lines, balanced). Hero.tsx splits on "," and inserts <br />. */
const HEADLINE = "Sign with your hands, they hear your voice";
/* keep subhead short enough to land on a single line at ~26px so it
 * doesn't bleed under the chat / editor glass panels horizontally. */
const SUBHEADLINE =
  "Real-time ASL-to-voice and live captions. Free, in your browser, no install.";
const CTA_LABEL = "Start a call";
const CTA_HREF = "/start";
const HERO_VIDEO = "/hero-header/hero-bg.mp4";
const HERO_SUBJECT = "/hero-header/hero-subject.webp";

export function HeroHeader() {
  return (
    <div className={s.root}>
      {/* banner is in flow only — scrolls away; nav alone is sticky */}
      <div className={s.bannerWrap}>
        <div className={s.headerInner}>
          <Banner text={BANNER_TEXT} cta={BANNER_CTA} href={BANNER_HREF} />
        </div>
      </div>
      <header className={s.header}>
        <div className={s.headerInner}>
          <Nav
            logo={<Logo size={84} wordmarkSize={37} surface="overlay" />}
            links={NAV_LINKS}
          />
        </div>
      </header>
      <Hero
        headline={HEADLINE}
        subheadline={SUBHEADLINE}
        ctaLabel={CTA_LABEL}
        ctaHref={CTA_HREF}
        videoSrc={HERO_VIDEO}
        subjectSrc={HERO_SUBJECT}
      />
    </div>
  );
}

export default HeroHeader;
