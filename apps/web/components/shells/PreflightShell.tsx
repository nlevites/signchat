import type { ReactNode } from "react";
import s from "./preflight-shell.module.css";

interface PreflightShellProps {
  hero: ReactNode;
  children: ReactNode;
}

export function PreflightShell({ hero, children }: PreflightShellProps) {
  return (
    <main className={s.shell}>
      <section className={s.frame}>
        <div className={s.plateElevated}>
          <div className={`sc-branded-frame ${s.framePlate}`}>
            <header className={s.logoStrip}>{hero}</header>
            <div className={s.frameInner}>{children}</div>
          </div>
        </div>
      </section>
    </main>
  );
}

export const preflightShell = s;
