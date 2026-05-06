"use client";

import {
  ArrowClockwise,
  CaretDown,
  Pause,
  Play,
  SpeakerHigh,
} from "@phosphor-icons/react/dist/ssr";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ElevenLabsVoiceSummary } from "@signchat/contracts";
import { cn } from "@/lib/cn";
import { usePreferencesStore, useVoicesStore } from "@/lib/stores";

export type VoicePickerTone = "light" | "dark";
export type VoicePickerMode = "list" | "dropdown";

interface VoicePickerProps {
  /**
   * Called after the underlying preference is updated. Lobby leaves it
   * undefined; the in-call SettingsPanel passes a callback that invalidates
   * the cached signed URL and re-mints with the new voice id.
   */
  onChange?: (voiceId: string | null) => void;
  tone?: VoicePickerTone;
  mode?: VoicePickerMode;
  className?: string;
}

interface Group {
  key: string;
  label: string;
  voices: ElevenLabsVoiceSummary[];
}

const CATEGORY_ORDER: ReadonlyArray<{ key: string; label: string }> = [
  { key: "premade", label: "Premade" },
  { key: "professional", label: "Professional" },
  { key: "cloned", label: "My voices" },
  { key: "generated", label: "Generated" },
];

function groupVoices(voices: readonly ElevenLabsVoiceSummary[]): Group[] {
  const buckets = new Map<string, ElevenLabsVoiceSummary[]>();
  for (const v of voices) {
    const key = v.category || "other";
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(v);
  }
  const out: Group[] = [];
  for (const meta of CATEGORY_ORDER) {
    const arr = buckets.get(meta.key);
    if (arr && arr.length > 0) {
      out.push({ key: meta.key, label: meta.label, voices: arr });
      buckets.delete(meta.key);
    }
  }
  const remaining: ElevenLabsVoiceSummary[] = [];
  for (const arr of buckets.values()) remaining.push(...arr);
  if (remaining.length > 0) {
    out.push({ key: "other", label: "Other", voices: remaining });
  }
  for (const g of out) g.voices.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

// ElevenLabs returns labels with snake_case (e.g. "middle_aged"); humanize for display.
function humanize(raw: string): string {
  const cleaned = raw.replace(/_/g, " ").trim();
  if (!cleaned) return cleaned;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function summarizeLabels(
  labels?: ElevenLabsVoiceSummary["labels"],
): string | null {
  if (!labels) return null;
  const out: string[] = [];
  if (labels.gender) out.push(humanize(labels.gender));
  if (labels.accent) out.push(humanize(labels.accent));
  if (labels.age) out.push(humanize(labels.age));
  if (out.length === 0) return null;
  return out.join(" · ");
}

export function VoicePicker({
  onChange,
  tone = "light",
  mode = "list",
  className,
}: VoicePickerProps) {
  const status = useVoicesStore((s) => s.status);
  const voices = useVoicesStore((s) => s.voices);
  const defaultVoiceId = useVoicesStore((s) => s.defaultVoiceId);
  const error = useVoicesStore((s) => s.error);
  const load = useVoicesStore((s) => s.load);

  const selectedVoiceId = usePreferencesStore((s) => s.elevenlabsVoiceId);
  const setElevenlabsVoiceId = usePreferencesStore(
    (s) => s.setElevenlabsVoiceId,
  );

  useEffect(() => {
    void load();
  }, [load]);

  const groups = useMemo(() => groupVoices(voices), [voices]);

  // dropdown mode: trigger toggles a panel containing the same grouped list.
  // wrapper handles outside-click + Escape so the lobby can collapse the
  // long list into a single row that fits the side column without scroll.
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mode !== "dropdown" || !open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [mode, open]);

  const selectedVoice = useMemo(() => {
    if (selectedVoiceId === null) return null;
    return voices.find((v) => v.voiceId === selectedVoiceId) ?? null;
  }, [voices, selectedVoiceId]);

  // Singleton <audio> for previews so switching voices interrupts the prior
  // sample instead of stacking. Created on first interaction; previews never
  // touch the LiveKit/mixer pipeline so callers can safely sample mid-call.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      const el = audioRef.current;
      if (!el) return;
      el.pause();
      el.src = "";
      audioRef.current = null;
    };
  }, []);

  const stopPreview = () => {
    const el = audioRef.current;
    if (el) {
      el.pause();
      el.currentTime = 0;
    }
    setPreviewingId(null);
  };

  const playPreview = (voice: ElevenLabsVoiceSummary) => {
    if (!voice.previewUrl) return;
    if (previewingId === voice.voiceId) {
      stopPreview();
      return;
    }
    let el = audioRef.current;
    if (!el) {
      el = new Audio();
      audioRef.current = el;
      el.addEventListener("ended", () => setPreviewingId(null));
      el.addEventListener("error", () => setPreviewingId(null));
    }
    if (el.src !== voice.previewUrl) {
      el.src = voice.previewUrl;
    } else {
      el.currentTime = 0;
    }
    setPreviewingId(voice.voiceId);
    void el.play().catch(() => setPreviewingId(null));
  };

  const handleSelect = (voiceId: string | null) => {
    setElevenlabsVoiceId(voiceId);
    if (onChange) onChange(voiceId);
    if (mode === "dropdown") {
      stopPreview();
      setOpen(false);
    }
  };

  const palette = tone === "dark" ? DARK : LIGHT;

  const loading = status === "idle" || status === "loading";
  const errored = status === "error";

  let inner: React.ReactNode;
  if (loading) {
    inner = (
      <div
        className={cn(
          "rounded-sc-md border px-3 py-3 t-body-sm",
          palette.skeleton,
        )}
      >
        Loading voices…
      </div>
    );
  } else if (errored) {
    inner = (
      <div
        className={cn(
          "flex items-start justify-between gap-3 rounded-sc-md border px-3 py-3 t-body-sm",
          palette.error,
        )}
      >
        <span className="min-w-0 flex-1 break-words">
          {error ?? "Could not load voices."}
        </span>
        <button
          type="button"
          onClick={() => void load({ force: true })}
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-sc-full border px-2 py-0.5 t-meta",
            palette.errorButton,
          )}
        >
          <ArrowClockwise size={11} weight="bold" />
          Retry
        </button>
      </div>
    );
  } else {
    inner = (
      <ul
        className={cn(
          "flex flex-col gap-1 overflow-y-auto pr-0.5",
          mode === "dropdown" ? "max-h-[280px]" : "max-h-[360px]",
        )}
      >
        <VoiceRow
          tone={tone}
          name="System default"
          meta={
            defaultVoiceId
              ? `Voice ${defaultVoiceId.slice(0, 6)}…`
              : "Deployment default"
          }
          selected={selectedVoiceId === null}
          onSelect={() => handleSelect(null)}
        />
        {groups.map((group) => (
          <li key={group.key} className="flex min-w-0 flex-col gap-1">
            <p
              className={cn(
                "mt-2 px-1 t-meta uppercase tracking-[0.06em]",
                palette.groupLabel,
              )}
            >
              {group.label}
            </p>
            <ul className="flex flex-col gap-1">
              {group.voices.map((voice) => (
                <VoiceRow
                  key={voice.voiceId}
                  tone={tone}
                  name={voice.name}
                  meta={summarizeLabels(voice.labels) ?? undefined}
                  hasPreview={!!voice.previewUrl}
                  isPlaying={previewingId === voice.voiceId}
                  selected={selectedVoiceId === voice.voiceId}
                  onSelect={() => handleSelect(voice.voiceId)}
                  onTogglePreview={() => playPreview(voice)}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    );
  }

  if (mode === "dropdown") {
    const triggerLabel = loading
      ? "Loading voices…"
      : errored
        ? "Couldn't load voices"
        : selectedVoice
          ? selectedVoice.name
          : "System default";
    const triggerMeta = loading || errored
      ? null
      : selectedVoice
        ? summarizeLabels(selectedVoice.labels)
        : defaultVoiceId
          ? `Voice ${defaultVoiceId.slice(0, 6)}…`
          : "Deployment default";
    const triggerTone =
      tone === "dark"
        ? "border-white/15 bg-black/30 text-white hover:border-white/30"
        : "border-sc-border bg-sc-surface text-sc-text hover:border-sc-border-strong";
    const panelTone =
      tone === "dark"
        ? "border-white/15 bg-[#1f2569]/95 text-white shadow-sc-xl backdrop-blur-md"
        : "border-sc-border bg-sc-surface text-sc-text shadow-sc-md";
    return (
      <div
        ref={wrapperRef}
        className={cn("relative flex min-w-0 flex-col gap-1", className)}
      >
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex h-12 w-full items-center gap-3 rounded-sc-md border px-3 transition-[border-color,box-shadow,background-color] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] focus-visible:outline-none focus-visible:border-sc-accent-500 focus-visible:shadow-[var(--sc-glow-sm)]",
            triggerTone,
          )}
        >
          <span
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-full",
              tone === "dark" ? "bg-white/10 text-white" : "bg-sc-accent-soft text-sc-accent-700",
            )}
            aria-hidden
          >
            <SpeakerHigh size={14} weight="fill" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
            <span className="truncate t-body-sm font-medium">
              {triggerLabel}
            </span>
            {triggerMeta ? (
              <span
                className={cn(
                  "truncate t-meta",
                  tone === "dark" ? "text-white/60" : "text-sc-text-3",
                )}
              >
                {triggerMeta}
              </span>
            ) : null}
          </span>
          <CaretDown
            size={14}
            weight="bold"
            aria-hidden
            className={cn(
              "shrink-0 transition-transform duration-200",
              open && "rotate-180",
              tone === "dark" ? "text-white/55" : "text-sc-text-2",
            )}
          />
        </button>
        <AnimatePresence>
          {open ? (
            <motion.div
              role="listbox"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              className={cn(
                "absolute left-0 right-0 top-full z-50 mt-1 rounded-sc-lg border p-2",
                panelTone,
              )}
            >
              {inner}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Header tone={tone} />
      {inner}
    </div>
  );
}

interface VoiceRowProps {
  tone: VoicePickerTone;
  name: string;
  meta?: string | undefined;
  hasPreview?: boolean;
  isPlaying?: boolean;
  selected: boolean;
  onSelect: () => void;
  onTogglePreview?: () => void;
}

function VoiceRow({
  tone,
  name,
  meta,
  hasPreview,
  isPlaying,
  selected,
  onSelect,
  onTogglePreview,
}: VoiceRowProps) {
  const palette = tone === "dark" ? DARK : LIGHT;
  return (
    <li className="flex min-w-0">
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-sc-md border px-2 py-1.5 transition-[background-color,border-color,box-shadow] duration-150",
          selected ? palette.rowSelected : palette.rowDefault,
        )}
      >
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            aria-hidden
            className={cn(
              "relative inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border",
              selected ? palette.radioOn : palette.radioOff,
            )}
          >
            {selected ? (
              <span
                className={cn("size-1.5 rounded-full", palette.radioDot)}
              />
            ) : null}
          </span>
          <span className="flex min-w-0 flex-1 flex-col leading-tight">
            <span
              className={cn("truncate t-body-sm font-medium", palette.name)}
            >
              {name}
            </span>
            {meta ? (
              <span className={cn("truncate t-meta", palette.meta)}>
                {meta}
              </span>
            ) : null}
          </span>
        </button>
        {hasPreview && onTogglePreview ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePreview();
            }}
            aria-label={isPlaying ? "Stop preview" : "Play preview"}
            title={isPlaying ? "Stop preview" : "Play preview"}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-sc-full transition-[background-color,filter] duration-150",
              palette.previewButton,
              isPlaying && palette.previewButtonActive,
            )}
          >
            {isPlaying ? (
              <Pause size={11} weight="fill" />
            ) : (
              <Play size={11} weight="fill" />
            )}
          </button>
        ) : null}
      </div>
    </li>
  );
}

function Header({ tone }: { tone: VoicePickerTone }) {
  const palette = tone === "dark" ? DARK : LIGHT;
  return (
    <div className="flex items-center gap-1.5">
      <SpeakerHigh
        size={14}
        weight="fill"
        className={palette.headerIcon}
        aria-hidden
      />
      <span
        className={cn(
          "t-meta uppercase tracking-[0.06em]",
          palette.headerLabel,
        )}
      >
        Voice
      </span>
    </div>
  );
}

const LIGHT = {
  skeleton: "border-sc-border bg-sc-surface text-sc-text-3",
  error: "border-sc-warning/40 bg-sc-warning-subtle text-sc-warning",
  errorButton: "border-sc-warning/40 text-sc-warning hover:bg-sc-warning/10",
  rowDefault: "border-sc-border bg-sc-surface hover:border-sc-border-strong",
  rowSelected: "border-sc-accent-500 bg-sc-accent-soft",
  radioOff: "border-sc-border-strong bg-sc-surface",
  radioOn: "border-sc-accent-500 bg-sc-accent-500",
  radioDot: "bg-white",
  name: "text-sc-text",
  meta: "text-sc-text-3",
  previewButton:
    "bg-transparent text-sc-text-2 hover:bg-sc-surface-2 hover:text-sc-text",
  previewButtonActive: "bg-sc-accent-soft text-sc-accent-700",
  groupLabel: "text-sc-text-3",
  headerIcon: "text-sc-text-2",
  headerLabel: "text-sc-text-2",
} as const;

const DARK = {
  skeleton: "border-white/15 bg-black/30 text-white/65",
  error: "border-red-300/40 bg-red-500/10 text-red-200",
  errorButton: "border-red-300/40 text-red-200 hover:bg-red-500/15",
  rowDefault:
    "border-white/15 bg-black/30 hover:border-white/30 hover:bg-black/40",
  rowSelected: "border-sc-accent-300 bg-sc-accent-500/15",
  radioOff: "border-white/40 bg-black/40",
  radioOn: "border-sc-accent-300 bg-sc-accent-500",
  radioDot: "bg-white",
  name: "text-white",
  meta: "text-white/55",
  previewButton:
    "bg-transparent text-white/70 hover:bg-white/10 hover:text-white",
  previewButtonActive: "bg-sc-accent-500 text-white",
  groupLabel: "text-white/55",
  headerIcon: "text-white/65",
  headerLabel: "text-white/65",
} as const;
