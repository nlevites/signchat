import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import s from "./hero-header.module.css";

interface BannerProps {
  text: string;
  cta: string;
  href: string;
}

export function Banner({ text, cta, href }: BannerProps) {
  return (
    <Link className={s.banner} href={href}>
      <Logo size={48} showWordmark={false} surface="overlay" />
      <span className={s.bannerText}>{text}</span>
      <span className={s.bannerCta}>
        {cta}
        <ArrowRight size={14} weight="bold" />
      </span>
    </Link>
  );
}
