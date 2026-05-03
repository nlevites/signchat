import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";
import s from "./hero-header.module.css";

interface CTAButtonProps {
  href: string;
  children: ReactNode;
}

export function CTAButton({ href, children }: CTAButtonProps) {
  return (
    <Link href={href} className={s.cta}>
      <span>{children}</span>
      <span aria-hidden className={s.ctaIcon}>
        <ArrowRight size={20} weight="bold" />
      </span>
    </Link>
  );
}
