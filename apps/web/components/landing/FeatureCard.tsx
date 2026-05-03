import type { ReactNode } from "react";

export interface FeatureCardProps {
  icon: ReactNode;
  label: string;
  heading: string;
  body: string;
}

export function FeatureCard({ icon, label, heading, body }: FeatureCardProps) {
  return (
    <article className="rounded-card border border-fog bg-bone p-24 flex flex-col gap-16">
      <div className="flex items-center gap-8 text-iris">
        {icon}
        <span className="text-caption leading-caption font-semibold uppercase tracking-[0.04em]">
          {label}
        </span>
      </div>
      <h3 className="text-heading-sm leading-heading-sm tracking-heading-sm font-semibold text-ink">
        {heading}
      </h3>
      <p className="text-body leading-body text-graphite">{body}</p>
    </article>
  );
}
