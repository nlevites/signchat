"use client";

import { Microphone, SpeakerHigh, VideoCamera } from "@phosphor-icons/react/dist/ssr";
import { Select } from "@/components/ui/Select";
import { deviceLabel } from "@/lib/livekit/devices";
import { cn } from "@/lib/cn";

export type DeviceKind = "audioinput" | "videoinput" | "audiooutput";

interface DevicePickerProps {
  kind: DeviceKind;
  devices: readonly MediaDeviceInfo[];
  value: string;
  onChange: (deviceId: string) => void;
  tone?: "light" | "dark";
  className?: string;
}

const KIND_LABELS: Record<
  DeviceKind,
  { title: string; icon: React.ReactNode; fallback: string }
> = {
  audioinput: {
    title: "Microphone",
    icon: <Microphone size={14} weight="fill" />,
    fallback: "Microphone",
  },
  videoinput: {
    title: "Camera",
    icon: <VideoCamera size={14} weight="fill" />,
    fallback: "Camera",
  },
  audiooutput: {
    title: "Speakers",
    icon: <SpeakerHigh size={14} weight="fill" />,
    fallback: "Speakers",
  },
};

export function DevicePicker({
  kind,
  devices,
  value,
  onChange,
  tone = "light",
  className,
}: DevicePickerProps) {
  const meta = KIND_LABELS[kind];
  const empty = devices.length === 0;

  const options = empty
    ? [
        {
          value: "",
          label: `No ${meta.title.toLowerCase()} found`,
          disabled: true,
        },
      ]
    : devices.map((d) => ({
        value: d.deviceId,
        label: deviceLabel(d, meta.fallback),
      }));

  return (
    <label className={cn("flex flex-col gap-1.5", className)}>
      <span
        className={cn(
          "t-meta uppercase tracking-[0.06em] flex items-center gap-1.5",
          tone === "dark" ? "text-white/65" : "text-sc-text-2",
        )}
      >
        {meta.icon}
        {meta.title}
      </span>
      <Select
        tone={tone}
        value={value}
        onChange={onChange}
        options={options}
        disabled={empty}
        ariaLabel={meta.title}
        placeholder={`Select ${meta.title.toLowerCase()}`}
      />
    </label>
  );
}
