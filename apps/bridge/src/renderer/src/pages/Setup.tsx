import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from "react";
import type { ElevenLabsVoiceSummary } from "@signchat/contracts";
import {
  BLACKHOLE_HOMEPAGE,
  BLACKHOLE_INSTALL_STEPS,
  findBlackholeDevices,
  type AudioDeviceSummary,
  type BlackholeDevices,
} from "../lib/blackhole";
import { listElevenLabsVoices } from "../lib/bridge-credentials";
import { cn } from "../lib/cn";

export interface SetupResult {
  cameraDeviceId: string;
  micOutputDeviceId: string;
  loopbackInputDeviceId: string;
  voiceId: string;
}

export interface SetupProps {
  initial: SetupResult | null;
  onDone(result: SetupResult): void;
}

interface VoicesState {
  status: "idle" | "loading" | "ok" | "error";
  voices: ElevenLabsVoiceSummary[];
  defaultVoiceId: string | null;
  error?: string;
}

export function Setup({ initial, onDone }: SetupProps): JSX.Element {
  const [devices, setDevices] = useState<BlackholeDevices | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [scanning, setScanning] = useState(true);
  const [scanError, setScanError] = useState<string | null>(null);

  const [cameraId, setCameraId] = useState<string>(
    initial?.cameraDeviceId ?? "",
  );
  const [micId, setMicId] = useState<string>(initial?.micOutputDeviceId ?? "");
  const [loopbackId, setLoopbackId] = useState<string>(
    initial?.loopbackInputDeviceId ?? "",
  );

  const [voicesState, setVoicesState] = useState<VoicesState>({
    status: "idle",
    voices: [],
    defaultVoiceId: null,
  });
  const [voiceId, setVoiceId] = useState<string>(initial?.voiceId ?? "");

  const onceRef = useRef(false);

  // Scan devices on mount + on every refresh tick.
  useEffect(() => {
    let cancelled = false;
    setScanning(true);
    setScanError(null);
    void findBlackholeDevices()
      .then((next) => {
        if (cancelled) return;
        setDevices(next);
        // Auto-select sensible defaults the first time we see a device list.
        if (!onceRef.current) {
          onceRef.current = true;
          if (!cameraId && next.cameras[0]) {
            setCameraId(next.cameras[0].deviceId);
          }
          if (!micId && next.mic2ch) setMicId(next.mic2ch.deviceId);
          if (!loopbackId && next.loopback16ch) {
            setLoopbackId(next.loopback16ch.deviceId);
          }
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setScanError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setScanning(false);
      });
    return () => {
      cancelled = true;
    };
    // refreshKey deliberately drives the re-scan; the picker state setters
    // intentionally only fire on first scan via onceRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Mint the voices list once.
  useEffect(() => {
    let cancelled = false;
    setVoicesState({ status: "loading", voices: [], defaultVoiceId: null });
    void listElevenLabsVoices()
      .then((res) => {
        if (cancelled) return;
        setVoicesState({
          status: "ok",
          voices: res.voices,
          defaultVoiceId: res.defaultVoiceId,
        });
        if (!voiceId && res.defaultVoiceId) setVoiceId(res.defaultVoiceId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setVoicesState({
          status: "error",
          voices: [],
          defaultVoiceId: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
    // Run once. The voice list is small + cacheable; manual refresh isn't
    // a Setup-screen concern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const ready = useMemo(() => {
    return (
      cameraId.length > 0 &&
      micId.length > 0 &&
      loopbackId.length > 0 &&
      voiceId.length > 0
    );
  }, [cameraId, micId, loopbackId, voiceId]);

  const handleCopyBrew = useCallback(() => {
    const cmd =
      BLACKHOLE_INSTALL_STEPS.find((s) => s.id === "install")?.code ?? "";
    if (!cmd) return;
    void window.bridgeApi?.writeClipboard?.(cmd);
  }, []);

  const handleOpenBlackhole = useCallback(() => {
    void window.bridgeApi?.openExternal?.(BLACKHOLE_HOMEPAGE);
  }, []);

  const handleSubmit = () => {
    if (!ready) return;
    onDone({
      cameraDeviceId: cameraId,
      micOutputDeviceId: micId,
      loopbackInputDeviceId: loopbackId,
      voiceId,
    });
  };

  return (
    <div className="min-h-full overflow-y-auto bg-zinc-950 text-zinc-100">
      <div className="mx-auto flex max-w-2xl flex-col gap-6 px-6 pb-12 pt-10">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            Sign Chat Bridge
          </h1>
          <p className="text-sm text-zinc-400">
            Bridge runs the same sign-to-voice pipeline as signchat.org but
            routes the synthesised voice into a virtual mic and transcribes
            the call's incoming audio for the LLM context. One-time setup
            on macOS:
          </p>
        </header>

        <BlackholeStatus
          devices={devices}
          scanning={scanning}
          scanError={scanError}
          onRescan={() => setRefreshKey((n) => n + 1)}
          onCopyBrew={handleCopyBrew}
          onOpenBlackhole={handleOpenBlackhole}
        />

        <Section title="1. Camera">
          <DevicePicker
            placeholder="Choose a camera…"
            options={devices?.cameras ?? []}
            value={cameraId}
            onChange={setCameraId}
            emptyHint="Bridge needs camera access. Grant it in System Settings → Privacy & Security → Camera."
          />
        </Section>

        <Section
          title="2. Mic side — BlackHole 2ch"
          subtitle="Bridge plays its synthesised voice into this device. In Zoom / Discord, pick BlackHole 2ch as your microphone."
        >
          <DevicePicker
            placeholder="Choose a BlackHole 2ch output…"
            options={devices?.outputs ?? []}
            value={micId}
            onChange={setMicId}
            highlight={devices?.mic2ch?.deviceId}
            emptyHint="No audio outputs detected yet."
          />
        </Section>

        <Section
          title="3. Loopback side — BlackHole 16ch"
          subtitle="Bridge captures the call's audio from this device and transcribes it. Set up the Multi-Output Device once in Audio MIDI Setup."
        >
          <DevicePicker
            placeholder="Choose a BlackHole 16ch input…"
            options={devices?.inputs ?? []}
            value={loopbackId}
            onChange={setLoopbackId}
            highlight={devices?.loopback16ch?.deviceId}
            emptyHint="No audio inputs detected yet."
          />
        </Section>

        <Section
          title="4. Voice"
          subtitle="The ElevenLabs voice the synthesised speech uses. Defaults to the workbench voice id; switch any time."
        >
          <VoicePicker
            state={voicesState}
            value={voiceId}
            onChange={setVoiceId}
          />
        </Section>

        <div className="sticky bottom-0 -mx-6 mt-6 border-t border-zinc-800 bg-zinc-950/95 px-6 py-4 backdrop-blur">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!ready}
            className={cn(
              "w-full rounded-md px-4 py-2.5 text-sm font-semibold transition-colors",
              ready
                ? "bg-indigo-500 text-white hover:bg-indigo-400"
                : "cursor-not-allowed bg-zinc-800 text-zinc-500",
            )}
          >
            {ready ? "Continue" : "Pick a value in every section to continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface SectionProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function Section({ title, subtitle, children }: SectionProps): JSX.Element {
  return (
    <section className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
      <header>
        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
        {subtitle ? (
          <p className="mt-1 text-xs text-zinc-400">{subtitle}</p>
        ) : null}
      </header>
      <div className="pt-1">{children}</div>
    </section>
  );
}

interface DevicePickerProps {
  placeholder: string;
  options: AudioDeviceSummary[];
  value: string;
  onChange(next: string): void;
  /** Render the matching device with a small badge so it's obviously the right pick. */
  highlight?: string;
  emptyHint: string;
}

function DevicePicker({
  placeholder,
  options,
  value,
  onChange,
  highlight,
  emptyHint,
}: DevicePickerProps): JSX.Element {
  if (options.length === 0) {
    return (
      <p className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
        {emptyHint}
      </p>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
    >
      <option value="" disabled>
        {placeholder}
      </option>
      {options.map((opt) => {
        const isHighlight = opt.deviceId === highlight;
        const label =
          opt.label || (opt.deviceId === "default" ? "System default" : opt.deviceId.slice(0, 8));
        return (
          <option key={opt.deviceId} value={opt.deviceId}>
            {isHighlight ? "★ " : ""}
            {label}
          </option>
        );
      })}
    </select>
  );
}

interface BlackholeStatusProps {
  devices: BlackholeDevices | null;
  scanning: boolean;
  scanError: string | null;
  onRescan(): void;
  onCopyBrew(): void;
  onOpenBlackhole(): void;
}

function BlackholeStatus({
  devices,
  scanning,
  scanError,
  onRescan,
  onCopyBrew,
  onOpenBlackhole,
}: BlackholeStatusProps): JSX.Element {
  const mic2ch = devices?.mic2ch ?? null;
  const loopback16ch = devices?.loopback16ch ?? null;
  const allFound = mic2ch && loopback16ch;

  return (
    <section
      className={cn(
        "space-y-3 rounded-lg border p-4",
        allFound
          ? "border-emerald-700/60 bg-emerald-900/20"
          : "border-amber-700/60 bg-amber-900/20",
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-100">
          BlackHole virtual audio
        </h2>
        <button
          type="button"
          onClick={onRescan}
          disabled={scanning}
          className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
        >
          {scanning ? "Scanning…" : "Rescan devices"}
        </button>
      </header>

      <ul className="grid gap-2 text-xs">
        <li className="flex items-center gap-2">
          <Dot ok={!!mic2ch} />
          <span className="font-medium text-zinc-200">BlackHole 2ch</span>
          <span className="text-zinc-400">
            {mic2ch ? `detected (${mic2ch.label || mic2ch.deviceId})` : "not detected"}
          </span>
        </li>
        <li className="flex items-center gap-2">
          <Dot ok={!!loopback16ch} />
          <span className="font-medium text-zinc-200">BlackHole 16ch</span>
          <span className="text-zinc-400">
            {loopback16ch
              ? `detected (${loopback16ch.label || loopback16ch.deviceId})`
              : "not detected"}
          </span>
        </li>
      </ul>

      {scanError ? (
        <p className="rounded bg-red-950/60 px-2 py-1 text-xs text-red-200">
          Device scan error: {scanError}
        </p>
      ) : null}

      {!allFound ? (
        <ol className="space-y-3 border-t border-zinc-700/60 pt-3 text-xs text-zinc-300">
          {BLACKHOLE_INSTALL_STEPS.map((step, idx) => (
            <li key={step.id} className="space-y-1">
              <p className="font-semibold text-zinc-100">
                {idx + 1}. {step.title}
              </p>
              <p className="leading-relaxed text-zinc-400">{step.body}</p>
              {step.id === "install" && "code" in step && step.code ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 rounded bg-zinc-900 px-2 py-1 font-mono text-[11px] text-zinc-200">
                    {step.code}
                  </code>
                  <button
                    type="button"
                    onClick={onCopyBrew}
                    className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-800"
                  >
                    Copy
                  </button>
                </div>
              ) : null}
            </li>
          ))}
          <li>
            <button
              type="button"
              onClick={onOpenBlackhole}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800"
            >
              Open BlackHole homepage
            </button>
          </li>
        </ol>
      ) : null}
    </section>
  );
}

function Dot({ ok }: { ok: boolean }): JSX.Element {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block h-2 w-2 rounded-full",
        ok ? "bg-emerald-400" : "bg-amber-400",
      )}
    />
  );
}

interface VoicePickerProps {
  state: VoicesState;
  value: string;
  onChange(next: string): void;
}

function VoicePicker({ state, value, onChange }: VoicePickerProps): JSX.Element {
  if (state.status === "loading") {
    return (
      <p className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
        Loading voices…
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="rounded-md border border-red-800 bg-red-950/40 px-3 py-2 text-xs text-red-200">
        Couldn't load voices: {state.error ?? "unknown error"}
      </p>
    );
  }
  if (state.voices.length === 0) {
    return (
      <p className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-500">
        No voices returned by the API.
      </p>
    );
  }
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
    >
      {state.voices.map((voice) => (
        <option key={voice.voiceId} value={voice.voiceId}>
          {voice.name}
          {voice.voiceId === state.defaultVoiceId ? " (default)" : ""}
        </option>
      ))}
    </select>
  );
}
