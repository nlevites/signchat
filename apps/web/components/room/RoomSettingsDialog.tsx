"use client";

import { X } from "@phosphor-icons/react/dist/ssr";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useEffect } from "react";
import { ConnectionBadge } from "@/components/room/ConnectionBadge";
import { ViewToggle, type ViewMode } from "@/components/room/ViewToggle";
import { Logo } from "@/components/ui/Logo";

interface RoomSettingsDialogProps {
  open: boolean;
  onClose: () => void;
  roomId: string;
  view: ViewMode;
  onViewChange: (next: ViewMode) => void;
}

export function RoomSettingsDialog({
  open,
  onClose,
  roomId,
  view,
  onViewChange,
}: RoomSettingsDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          key="room-settings-root"
          className="fixed inset-0 z-40"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            aria-hidden
            className="absolute inset-0 bg-black/45"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby="room-settings-title"
              className="pointer-events-auto relative w-full max-w-md rounded-sc-2xl border border-sc-border bg-sc-surface p-6 shadow-sc-lg"
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 10 }}
              transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                className="absolute right-4 top-4 inline-flex size-9 items-center justify-center rounded-sc-full text-sc-text-2 transition-colors hover:bg-sc-surface-2 hover:text-sc-text"
              >
                <X size={20} weight="bold" />
              </button>

              <h2 id="room-settings-title" className="t-h3 text-sc-text pr-10">
                Call settings
              </h2>

              <div className="mt-6 flex flex-col gap-6">
                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    href="/"
                    aria-label="Signchat home"
                    className="rounded-sc-md transition-opacity hover:opacity-90"
                  >
                    <Logo size={44} wordmarkSize={28} surface="solid" />
                  </Link>
                  <span className="h-8 w-px bg-sc-divider" aria-hidden />
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="t-meta uppercase text-sc-text-3">Room</span>
                    <code className="truncate font-mono text-[15px] font-medium text-sc-text">
                      {roomId}
                    </code>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3">
                  <span className="t-meta uppercase text-sc-text-3">Connection</span>
                  <ConnectionBadge />
                </div>

                <div className="flex flex-col gap-2">
                  <span className="t-meta uppercase text-sc-text-3">View</span>
                  <ViewToggle surface value={view} onChange={onViewChange} />
                </div>
              </div>
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
