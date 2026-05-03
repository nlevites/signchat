import { ArrowRight } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface CtaButtonProps {
  href: string;
  children: ReactNode;
  className?: string;
}

export function CtaButton({ href, children, className }: CtaButtonProps) {
  return (
    <Link
      href={href}
      className={cn(
        "group inline-flex items-center gap-12 rounded-cta font-medium transition-transform duration-200 hover:-translate-y-px",
        className,
      )}
      style={{
        padding: "6px 6px 6px 16px",
        fontSize: "var(--text-body)",
        lineHeight: 1,
        color: "var(--color-bone)",
        background: "linear-gradient(rgb(27,25,56), rgb(27,25,56))",
        boxShadow:
          "rgba(14,18,27,0.24) 0 1px 2px 0, rgb(53,48,136) 0 0 0 1px",
      }}
    >
      <span style={{ color: "var(--color-bone)" }}>{children}</span>
      <span
        aria-hidden
        className="inline-grid place-items-center shrink-0"
        style={{
          width: 48,
          height: 36,
          borderRadius: 9,
          color: "var(--color-bone)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.18) 0%, rgba(255,255,255,0) 55%), linear-gradient(135deg, #8b6dff 0%, #5d42d8 55%, #4027a8 100%)",
          boxShadow:
            "inset 0 1px 1px rgba(255,255,255,0.25), 0 6px 18px rgba(112,84,255,0.30)",
        }}
      >
        <ArrowRight size={20} weight="bold" />
      </span>
    </Link>
  );
}
