import { GithubLogo, LinkedinLogo } from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import s from "./footer.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";

interface FooterLink {
  label: string;
  href: string;
  icon?: "github";
  external?: boolean;
}

interface FooterColumn {
  heading: string;
  links: FooterLink[];
}

const COLUMNS: FooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "Start a call", href: "/start" },
      {
        label: "Architecture",
        href: `${REPO_URL}/blob/main/ARCHITECTURE.md`,
        external: true,
      },
    ],
  },
  {
    heading: "Open source",
    links: [
      { label: "GitHub repo", href: REPO_URL, external: true, icon: "github" },
    ],
  },
];

export function Footer() {
  return (
    <footer className={s.footer}>
      <div className={s.inner}>
        <div className={s.top}>
          <div className={s.brand}>
            <Logo size={56} wordmarkSize={36} surface="overlay" />
            <p className={s.brandTagline}>
              Sign-language ↔ voice video chat that runs in your browser. No
              install, no backend, ~1-second end-to-end.
            </p>
            <span className={s.brandMeta}>v0.1.0</span>
            <p className={s.credit}>
              Built by{" "}
              <a
                className={s.creditLink}
                href="https://www.linkedin.com/in/bazarkua/"
                target="_blank"
                rel="noreferrer"
              >
                <LinkedinLogo size={14} weight="fill" aria-hidden />
                Adil
              </a>{" "}
              and{" "}
              <a
                className={s.creditLink}
                href="https://www.linkedin.com/in/nathan-levites/"
                target="_blank"
                rel="noreferrer"
              >
                <LinkedinLogo size={14} weight="fill" aria-hidden />
                Nathan
              </a>
              .
            </p>
          </div>

          {COLUMNS.map((col) => (
            <div key={col.heading} className={s.col}>
              <h2 className={s.colHead}>{col.heading}</h2>
              <ul className={s.colLinks}>
                {col.links.map((link) => (
                  <li key={link.href}>
                    <a
                      className={s.colLink}
                      href={link.href}
                      {...(link.external
                        ? { target: "_blank", rel: "noreferrer" }
                        : {})}
                    >
                      {link.icon === "github" ? (
                        <span className={s.colLinkIcon} aria-hidden>
                          <GithubLogo size={16} weight="fill" />
                        </span>
                      ) : null}
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>

      <div className={s.bigmarkWrap}>
        <span className={s.bigmark} aria-hidden>
          SIGNCHAT
        </span>
      </div>
    </footer>
  );
}

export default Footer;
