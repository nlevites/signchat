import type { ReactNode } from "react";

export interface FeatureCardProps {
  icon: ReactNode;
  label: string;
  heading: string;
  body: string;
  variant?: "deep" | "surface";
}

export function FeatureCard({
  icon,
  label,
  heading,
  body,
  variant = "deep",
}: FeatureCardProps) {
  if (variant === "deep") {
    return (
      <article className="sc-feature-card relative flex flex-col gap-4 rounded-sc-2xl p-8">
        <div className="relative flex items-center gap-2 text-sc-accent-300">
          {icon}
          <span className="t-meta uppercase">{label}</span>
        </div>
        <h3 className="relative t-h1 text-white">{heading}</h3>
        <p className="relative t-body text-white/80">{body}</p>
      </article>
    );
  }
  return (
    <article className="flex flex-col gap-4 rounded-sc-xl border border-sc-border bg-sc-surface p-8 shadow-sc-sm">
      <div className="flex items-center gap-2 text-sc-accent-600">
        {icon}
        <span className="t-meta uppercase">{label}</span>
      </div>
      <h3 className="t-h1 text-sc-text">{heading}</h3>
      <p className="t-body text-sc-text-2">{body}</p>
    </article>
  );
}
