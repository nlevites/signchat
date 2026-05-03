import s from "./impact-band.module.css";

interface Stat {
  number: string;
  caption: string;
  source?: { label: string; href: string };
}

const STATS: Stat[] = [
  {
    number: "~500K",
    caption: "Americans whose primary language is ASL",
    source: {
      label: "NIDCD",
      href: "https://www.nidcd.nih.gov/health/statistics/quick-statistics-hearing",
    },
  },
  {
    number: "~10K",
    caption: "certified ASL interpreters in the U.S.",
    source: {
      label: "Language Services Associates",
      href: "https://lsa.inc/why-is-there-a-shortage-of-certified-american-sign-language-interpreters/",
    },
  },
  {
    number: "<1 sec",
    caption: "sign to spoken voice — less than 1 second at P50",
  },
];

export function ImpactBand() {
  return (
    <section className={s.impact} aria-label="Why Signchat exists">
      <div className={s.inner}>
        <header className={s.head}>
          <span className={s.eyebrow}>Why we exist</span>
          <h2 className={s.heading}>Interpreter math doesn&rsquo;t work</h2>
          <p className={s.lede}>
            About 500,000 Americans speak ASL as their primary language. The
            US has roughly 10,000 certified ASL interpreters, while most of
            them are scheduled into healthcare, legal, and government calls.
            For casual video calls with a friend, family member, or coworkers,
            the deaf side has been left out.
          </p>
        </header>
        <ul className={s.stats}>
          {STATS.map((stat) => (
            <li key={stat.caption}>
              <span className={s.statNumber}>{stat.number}</span>
              <span className={s.statCaption}>{stat.caption}</span>
              {stat.source ? (
                <a
                  className={s.statSource}
                  href={stat.source.href}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {stat.source.label}
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        <p className={s.punchline}>Signchat fills the gap.</p>
      </div>
    </section>
  );
}

export default ImpactBand;
