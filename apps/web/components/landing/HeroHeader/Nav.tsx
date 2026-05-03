import { CaretDown } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { ReactNode } from "react";
import s from "./hero-header.module.css";

interface NavProps {
  logo: ReactNode;
  links: readonly string[];
  /** where the lavender call-to-action button sends the user. defaults to
   * the project's existing call-start route. */
  startHref?: string;
}

/* Product dropdown items map to REAL Signchat surfaces from the
 * architecture / PRD — no invented "agent store" / "studio" entries.
 *  - Signchat Web      → / (the browser 1:1 video app)
 *  - Signchat Bridge   → shipping Electron desktop app (architecture §16)
 *  - ASL Classifier    → custom ASL classifier ONNX model (architecture §5.4)
 *  - Sign Pipeline     → packages/sign-pipeline + prompts
 *  - Architecture      → public technical spec
 * Routes that don't exist yet 404 — that's intentional per spec. */
const PRODUCT_ITEMS = [
  { label: "Signchat Web",     href: "/" },
  { label: "Signchat Bridge",  href: "/bridge" },
  { label: "ASL Classifier",   href: "/classifier" },
  { label: "Sign Pipeline",    href: "/pipeline" },
  { label: "Architecture",     href: "/architecture" },
] as const;

export function Nav({ logo, links, startHref = "/start" }: NavProps) {
  return (
    <nav className={s.nav} aria-label="Primary">
      <div className={s.navLeft}>
        <Link className={s.navLogo} href="/" aria-label="Signchat home">
          {logo}
        </Link>
        <ul className={s.navLinks}>
          {links.map((label) => {
            if (label === "Product") {
              return (
                <li key={label} className={s.navItem}>
                  <button
                    type="button"
                    className={`${s.navLink} ${s.navTrigger}`}
                    aria-haspopup="menu"
                  >
                    {label}
                    <CaretDown size={12} weight="bold" />
                  </button>
                  <div className={s.navDropdown} role="menu">
                    <ul className={s.navDropdownList}>
                      {PRODUCT_ITEMS.map((item) => (
                        <li key={item.href}>
                          <Link
                            className={s.navDropdownItem}
                            href={item.href}
                            role="menuitem"
                          >
                            {item.label}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              );
            }
            return (
              <li key={label}>
                <Link className={s.navLink} href={`/${label.toLowerCase()}`}>
                  {label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
      <div className={s.navSpacer} aria-hidden />
      <div className={s.navRight}>
        <Link className={s.navSignup} href={startHref}>Start a call</Link>
      </div>
    </nav>
  );
}
