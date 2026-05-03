"use client";

import {
  ChatCircleText,
  Gear,
  Microphone,
  MicrophoneSlash,
  PhoneSlash,
  VideoCamera,
  VideoCameraSlash,
} from "@phosphor-icons/react/dist/ssr";

interface ControlBarProps {
  micEnabled: boolean;
  camEnabled: boolean;
  chatOpen: boolean;
  settingsOpen: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onToggleChat: () => void;
  onToggleSettings: () => void;
  onLeave: () => void;
}

export function ControlBar({
  micEnabled,
  camEnabled,
  chatOpen,
  settingsOpen,
  onToggleMic,
  onToggleCam,
  onToggleChat,
  onToggleSettings,
  onLeave,
}: ControlBarProps) {
  return (
    <div className="absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-sc-full border border-sc-border bg-sc-surface/95 px-2 py-2 shadow-sc-lg backdrop-blur-md">
        <ControlButton
          label={micEnabled ? "Mute mic" : "Unmute mic"}
          onClick={onToggleMic}
          muted={!micEnabled}
        >
          {micEnabled ? (
            <Microphone size={18} weight="fill" />
          ) : (
            <MicrophoneSlash size={18} weight="fill" />
          )}
        </ControlButton>
        <ControlButton
          label={camEnabled ? "Turn camera off" : "Turn camera on"}
          onClick={onToggleCam}
          muted={!camEnabled}
        >
          {camEnabled ? (
            <VideoCamera size={18} weight="fill" />
          ) : (
            <VideoCameraSlash size={18} weight="fill" />
          )}
        </ControlButton>
        <ControlButton
          label="Settings"
          onClick={onToggleSettings}
          tone="neutral"
          active={settingsOpen}
        >
          <Gear size={18} weight="fill" />
        </ControlButton>
        <ControlButton
          label={chatOpen ? "Hide chat" : "Show chat"}
          onClick={onToggleChat}
          tone="neutral"
          active={chatOpen}
        >
          <ChatCircleText size={18} weight="fill" />
        </ControlButton>
        <span className="mx-1 h-6 w-px bg-sc-divider" aria-hidden />
        <ControlButton label="Leave call" onClick={onLeave} tone="leave">
          <PhoneSlash size={18} weight="fill" />
        </ControlButton>
      </div>
    </div>
  );
}

type Tone = "default" | "neutral" | "leave";

interface ControlButtonProps {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  muted?: boolean;
  tone?: Tone;
}

function ControlButton({
  children,
  label,
  onClick,
  active,
  muted,
  tone = "default",
}: ControlButtonProps) {
  const styles =
    tone === "leave"
      ? "bg-sc-danger text-white hover:brightness-95"
      : muted
        ? "bg-sc-danger text-white"
        : active
          ? "bg-sc-accent-soft text-sc-accent-700"
          : "bg-transparent text-sc-text-2 hover:bg-sc-surface-2";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={
        "inline-flex size-10 items-center justify-center rounded-sc-full transition-[background-color,color,filter] duration-200 " +
        styles
      }
    >
      {children}
    </button>
  );
}
