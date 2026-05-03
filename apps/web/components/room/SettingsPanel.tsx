"use client";

import { Check, Copy, Gear, X } from "@phosphor-icons/react/dist/ssr";
import type { Role } from "@signchat/contracts";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ConnectionBadge } from "@/components/room/ConnectionBadge";
import { VoicePicker } from "@/components/room/VoicePicker";
import { ViewToggle, type ViewMode } from "@/components/room/ViewToggle";
import { Logo } from "@/components/ui/Logo";
import { useCredentialsStore } from "@/lib/credentials/store";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mintElevenLabsSignedUrl } from "@/lib/livekit/mint-elevenlabs";
import { useRoomStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

interface SettingsPanelProps {
  role: Role;
  onClose: () => void;
  /** roomId + view-toggle were displayed in a top-of-page header before;
   * they live inside this panel now so the room canvas owns the full
   * screen and these controls are still one click away. */
  roomId: string;
  view: ViewMode;
  onChangeView: (next: ViewMode) => void;
  inviteUrl?: string;
}

export function SettingsPanel({
  role,
  onClose,
  roomId,
  view,
  onChangeView,
  inviteUrl,
}: SettingsPanelProps) {
  const isDeaf = role === "deaf";

  const handleVoiceChange = (voiceId: string | null) => {
    const { roomId: rid, identity } = useRoomStore.getState();
    useCredentialsStore.getState().setElevenLabs(null);
    if (!rid || !identity) return;
    void mintElevenLabsSignedUrl({
      roomId: rid,
      identity,
      role: "deaf",
      ...(voiceId ? { voiceId } : {}),
    })
      .then((fresh) => {
        useCredentialsStore.getState().setElevenLabs({
          signedUrl: fresh.signedUrl,
          voiceId: fresh.voiceId,
          modelId: fresh.modelId,
          outputFormat: fresh.outputFormat,
          expiresAt: fresh.expiresAt,
        });
        LogBus.info("settings", "elevenlabs url re-minted for voice change", {
          voiceId: fresh.voiceId,
        });
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        LogBus.warn("settings", "voice-change re-mint failed", {
          error: message,
        });
        toast.error("Voice change failed — try again");
      });
  };

  return (
    <div className="flex h-full flex-col bg-sc-surface">
      <header className="flex shrink-0 items-center justify-between border-b border-sc-divider px-4 py-3">
        <span className="inline-flex items-center gap-2 t-meta uppercase text-sc-text-3">
          <Gear size={14} weight="fill" />
          Settings
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close settings"
          title="Close settings"
          className="inline-flex size-7 items-center justify-center rounded-sc-full text-sc-text-3 transition-colors duration-150 hover:bg-sc-surface-2 hover:text-sc-text-2"
        >
          <X size={14} weight="bold" />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <section className="flex flex-col gap-3 border-b border-sc-divider pb-4">
          <div className="flex items-center justify-between">
            <Link
              href="/"
              aria-label="Signchat home"
              className="inline-flex rounded-sc-md transition-opacity hover:opacity-90"
            >
              <Logo size={36} wordmarkSize={22} surface="solid" />
            </Link>
            <ConnectionBadge />
          </div>

          <RoomCopy roomId={roomId} inviteUrl={inviteUrl} />

          <div className="flex items-center justify-between gap-3">
            <span className="t-meta uppercase text-sc-text-3">View</span>
            <ViewToggle value={view} onChange={onChangeView} surface />
          </div>
        </section>

        <section className="flex flex-col gap-2 pt-4">
          <p className="t-body-sm font-medium text-sc-text">Voice</p>
          {isDeaf ? (
            <>
              <p className="t-body-sm text-sc-text-2">
                Pick the voice the hearing participant hears when you sign.
                Changes take effect on your next sentence.
              </p>
              <VoicePicker onChange={handleVoiceChange} />
            </>
          ) : (
            <p className="t-body-sm text-sc-text-2">
              The deaf participant chooses which ElevenLabs voice you hear when
              they sign. They can change it any time from their own settings
              panel.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}

interface RoomCopyProps {
  roomId: string;
  inviteUrl?: string;
}

function RoomCopy({ roomId, inviteUrl }: RoomCopyProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(t);
  }, [copied]);

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      toast.success("Room link copied");
    } catch (err) {
      console.warn("[settings] clipboard write failed", err);
      toast.error("Could not copy link");
    }
  };

  return (
    <div className="flex items-center justify-between gap-2 rounded-sc-md border border-sc-border bg-sc-surface-2 px-3 py-2">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="t-meta uppercase text-sc-text-3">Room</span>
        <code className="truncate font-mono text-[13px] font-medium text-sc-text">
          {roomId}
        </code>
      </div>
      <button
        type="button"
        onClick={() => void handleCopy()}
        disabled={!inviteUrl}
        aria-label="Copy room link"
        title="Copy room link"
        className="inline-flex h-7 items-center gap-1 rounded-sc-full bg-sc-accent-soft px-2.5 text-[12px] font-medium text-sc-accent-700 transition-[filter] duration-200 hover:brightness-95 disabled:pointer-events-none disabled:opacity-40"
      >
        {copied ? <Check size={12} weight="bold" /> : <Copy size={12} weight="bold" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
