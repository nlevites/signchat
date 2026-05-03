"use client";

import {
  CheckCircle,
  Info,
  WarningCircle,
  XCircle,
} from "@phosphor-icons/react/dist/ssr";
import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";
import {
  type ToastKind,
  type ToastMessage,
  useToastStore,
} from "@/lib/stores/toast";

const ERROR_AUTODISMISS_MS = 5000;

interface KindStyles {
  container: string;
  icon: React.ComponentType<{ size?: number; weight?: "regular" | "fill" }>;
  iconWeight: "regular" | "fill";
}

const KIND_STYLES: Record<ToastKind, KindStyles> = {
  info: {
    container:
      "border-l-2 border-sc-accent-500 bg-sc-surface text-sc-text shadow-sc-md",
    icon: Info,
    iconWeight: "regular",
  },
  warn: {
    container:
      "rounded-sc-full bg-sc-warning-subtle text-sc-warning shadow-sc-md",
    icon: WarningCircle,
    iconWeight: "fill",
  },
  error: {
    container: "rounded-sc-md bg-sc-danger text-white shadow-sc-md",
    icon: XCircle,
    iconWeight: "fill",
  },
  success: {
    container: "bg-sc-surface text-sc-text shadow-sc-md",
    icon: CheckCircle,
    iconWeight: "fill",
  },
};

export function ToastContainer() {
  const messages = useToastStore((s) => s.messages);
  return (
    <div
      aria-live="polite"
      aria-atomic
      className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex flex-col items-center gap-2 px-4"
    >
      <AnimatePresence initial={false}>
        {messages.map((m) => (
          <ToastItem key={m.id} message={m} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastItem({ message }: { message: ToastMessage }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const styles = KIND_STYLES[message.kind];
  const Icon = styles.icon;

  useEffect(() => {
    if (message.kind !== "error") return;
    const t = window.setTimeout(() => dismiss(message.id), ERROR_AUTODISMISS_MS);
    return () => window.clearTimeout(t);
  }, [message.id, message.kind, dismiss]);

  return (
    <motion.div
      role={message.kind === "error" ? "alert" : "status"}
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={
        "pointer-events-auto inline-flex max-w-[440px] items-start gap-2 px-4 py-2.5 t-body-sm " +
        styles.container
      }
    >
      <Icon size={18} weight={styles.iconWeight} />
      <span className="flex-1 leading-snug">{message.text}</span>
      <button
        type="button"
        onClick={() => dismiss(message.id)}
        aria-label="Dismiss"
        className="-mr-1 ml-2 rounded-sc-sm px-1 text-current opacity-70 transition-opacity hover:opacity-100"
      >
        ×
      </button>
    </motion.div>
  );
}
