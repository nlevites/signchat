"use client";

import { Gear, X } from "@phosphor-icons/react/dist/ssr";
import type { Role } from "@signchat/contracts";
import { VoicePicker } from "@/components/room/VoicePicker";
import { useCredentialsStore } from "@/lib/credentials/store";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mintElevenLabsSignedUrl } from "@/lib/livekit/mint-elevenlabs";
import { useRoomStore } from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

interface SettingsPanelProps {
  role: Role;
  onClose: () => void;
}

export function SettingsPanel({ role, onClose }: SettingsPanelProps) {
  const isDeaf = role === "deaf";

  // Mid-call swap: drop the cached single-use URL so the next utterance is
  // forced to mint with the freshly-picked voiceId, then kick off a
  // background pre-mint so there's zero added latency on the next turn.
  // Reading roomId/identity at call time keeps this stable across renders.
  const handleVoiceChange = (voiceId: string | null) => {
    const { roomId, identity } = useRoomStore.getState();
    useCredentialsStore.getState().setElevenLabs(null);
    if (!roomId || !identity) return;
    void mintElevenLabsSignedUrl({
      roomId,
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
        {isDeaf ? (
          <section className="flex flex-col gap-2">
            <p className="t-body-sm text-sc-text-2">
              Pick the voice the hearing participant hears when you sign.
              Changes take effect on your next sentence.
            </p>
            <VoicePicker onChange={handleVoiceChange} />
          </section>
        ) : (
          <section className="flex flex-col gap-2">
            <p className="t-body-sm font-medium text-sc-text">Voice</p>
            <p className="t-body-sm text-sc-text-2">
              The deaf participant chooses which ElevenLabs voice you hear when
              they sign. They can change it any time from their own settings
              panel.
            </p>
          </section>
        )}
      </div>
    </div>
  );
}
