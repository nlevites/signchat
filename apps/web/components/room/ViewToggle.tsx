"use client";

import { motion } from "motion/react";

export type ViewMode = "production" | "debug";

interface ViewToggleProps {
  value: ViewMode;
  onChange: (next: ViewMode) => void;
}

const OPTIONS: readonly { id: ViewMode; label: string }[] = [
  { id: "production", label: "Production" },
  { id: "debug", label: "Debug" },
];

export function ViewToggle({ value, onChange }: ViewToggleProps) {
  return (
    <div className="relative inline-flex rounded-sc-full border border-white/30 bg-white/15 p-1 backdrop-blur">
      {OPTIONS.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            onClick={() => onChange(opt.id)}
            aria-pressed={active}
            className="relative z-10 inline-flex h-7 items-center px-3 text-[13px] font-medium"
          >
            {active ? (
              <motion.span
                layoutId="view-toggle-pill"
                className="absolute inset-0 -z-10 rounded-sc-full bg-white shadow-[0_2px_6px_rgba(20,22,38,0.18)]"
                transition={{ type: "spring", stiffness: 320, damping: 32 }}
              />
            ) : null}
            <span className={active ? "text-sc-accent-700" : "text-white/80"}>
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
