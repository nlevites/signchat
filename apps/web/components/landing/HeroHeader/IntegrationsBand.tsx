import s from "./hero-header.module.css";

const HEADING =
  "Signchat Bridge connects to the tools your team already uses";

/** SVG sources + license info live in public/integrations/manifest.json.
 * SVGs are fetched from Wikimedia Commons by scripts/fetch-integration-logos.mjs.
 * Brand colors are preserved per spec.
 *
 * Some Wikimedia files ship icon-only (Teams, Meet, Slack). For those we
 * pair the icon with a text wordmark in the brand's primary color so the
 * row reads as a uniform lockup. Discord/Webex/Zoom already include the
 * wordmark in the SVG. */
interface Integration {
  slug: string;
  label: string;
  href: string;
  /** widths vary per brand; cap so one wide wordmark doesn't dominate. */
  maxWidth: number;
  /** when set, render <img> + text wordmark in this brand color. */
  wordmarkColor?: string;
  /** override icon size when paired with text — default 24. */
  iconSize?: number;
}

const INTEGRATIONS: Integration[] = [
  { slug: "zoom",    label: "Zoom",            href: "https://zoom.us",                                       maxWidth: 96 },
  { slug: "teams",   label: "Microsoft Teams", href: "https://www.microsoft.com/microsoft-teams",             maxWidth: 168, wordmarkColor: "#4b53bc", iconSize: 22 },
  { slug: "meet",    label: "Google Meet",     href: "https://meet.google.com",                               maxWidth: 156, wordmarkColor: "#5f6368", iconSize: 22 },
  { slug: "slack",   label: "Slack",           href: "https://slack.com",                                     maxWidth: 112, wordmarkColor: "#1d1c1d", iconSize: 22 },
  { slug: "discord", label: "Discord",         href: "https://discord.com",                                   maxWidth: 132 },
  { slug: "webex",   label: "Webex",           href: "https://www.webex.com",                                 maxWidth: 96 },
];

export function IntegrationsBand() {
  return (
    <section className={s.integrationsBand} aria-label="Integrations">
      <div className={s.integrationsInner}>
        <h2 className={s.integrationsHeading}>{HEADING}</h2>
        <ul className={s.integrationsLogos}>
          {INTEGRATIONS.map(({ slug, label, href, maxWidth, wordmarkColor, iconSize }) => (
            <li key={slug}>
              <a
                href={href}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`${label} (opens in new tab)`}
              >
                {wordmarkColor ? (
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 8,
                      maxWidth,
                    }}
                  >
                    <img
                      src={`/integrations/${slug}.svg`}
                      alt=""
                      aria-hidden
                      height={iconSize ?? 24}
                      style={{ height: iconSize ?? 24, width: "auto" }}
                    />
                    <span
                      style={{
                        fontSize: 16,
                        fontWeight: 600,
                        letterSpacing: "-0.02em",
                        lineHeight: 1,
                        color: wordmarkColor,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </span>
                  </span>
                ) : (
                  <img
                    src={`/integrations/${slug}.svg`}
                    alt={label}
                    height={24}
                    style={{ maxWidth, height: 24, width: "auto" }}
                  />
                )}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
