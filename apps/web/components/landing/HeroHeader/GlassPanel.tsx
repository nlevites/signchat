import type { CSSProperties, ReactNode } from "react";
import s from "./hero-header.module.css";

type Slot =
  | "chat"
  | "agents"
  | "search"
  | "editor"
  | "reply"
  | "mail"
  | "scheduler";

function slotClass(slot: Slot): string {
  switch (slot) {
    case "chat":      return s.slotChat;
    case "agents":    return s.slotAgents;
    case "search":    return s.slotSearch;
    case "editor":    return s.slotEditor;
    case "reply":     return s.slotReply;
    case "mail":      return s.slotMail;
    case "scheduler": return s.slotScheduler;
  }
}

interface GlassPanelProps {
  slot: Slot;
  index: number;
  pill?: boolean;
  rounded?: boolean;
  children: ReactNode;
  ariaLabel?: string;
}

export function GlassPanel({
  slot,
  index,
  pill,
  rounded,
  children,
  ariaLabel,
}: GlassPanelProps) {
  const variant = pill ? s.panelPill : rounded ? s.panelRounded : "";
  return (
    <div
      role="presentation"
      aria-label={ariaLabel}
      className={[s.panel, variant, slotClass(slot)].filter(Boolean).join(" ")}
      style={{ "--sh-index": String(index) } as CSSProperties}
    >
      {children}
    </div>
  );
}
