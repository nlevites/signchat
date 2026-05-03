import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import type {
  ParticipantInfo,
  ReconstructionPayload,
} from "@signchat/contracts";
import {
  acquireController,
  useModeSnapshot,
} from "@signchat/runtime-browser/mode-controller/controller-store";
import type { ModeController } from "@signchat/runtime-browser/mode-controller/mode-controller";
import { reconstruct } from "@signchat/runtime-browser/openrouter/client";
import {
  openTurnWss,
  speak,
} from "@signchat/runtime-browser/elevenlabs/streaming";
import {
  createSttStream,
  type SttStream,
} from "@signchat/runtime-browser/elevenlabs/stt-streaming";
import type { VoiceMixer } from "@signchat/runtime-browser/audio/voice-mixer";
import { log } from "@signchat/runtime-browser/logger";
import type { ReconstructionModelId } from "@signchat/prompts";
import type { VisionFrame } from "@signchat/runtime-browser/sign-pipeline/mediapipe-runner";

import { CameraView } from "../components/CameraView";
import { TokenChips } from "../components/TokenChips";
import { PreviewCard } from "../components/PreviewCard";
import { useClassifier } from "../hooks/useClassifier";
import { useCredentials } from "../hooks/useCredentials";
import { createBridgeAudioSink } from "../lib/bridge-audio-sink";
import {
  HearingTranscript,
  useHearingTranscript,
} from "../lib/hearing-transcript";
import {
  openBridgeSystemAudio,
  type BridgeSystemAudio,
} from "../lib/bridge-system-audio";
import { cn } from "../lib/cn";

export interface ActiveProps {
  cameraDeviceId: string;
  micOutputDeviceId: string;
  loopbackInputDeviceId: string;
  voiceId: string;
  onReconfigure(): void;
}

const HEARING_PARTICIPANT: ParticipantInfo = {
  identity: "bridge-hearing",
  name: "Hearing",
  role: "hearing",
};

export function Active(props: ActiveProps): JSX.Element {
  const {
    cameraDeviceId,
    micOutputDeviceId,
    loopbackInputDeviceId,
    voiceId,
    onReconfigure,
  } = props;

  const credentials = useCredentials(voiceId);
  const snapshot = useModeSnapshot();
  const transcript = useHearingTranscript();

  const controllerRef = useRef<ModeController | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const mixerRef = useRef<VoiceMixer | null>(null);
  const sttStreamRef = useRef<SttStream | null>(null);
  const loopbackRef = useRef<BridgeSystemAudio | null>(null);
  const stitchEpochRef = useRef<number>(-1);
  const speakEpochRef = useRef<number>(-1);
  const approveContextRef = useRef<{
    confidence: ReconstructionPayload["confidence"];
    usedSigns: string[];
  } | null>(null);

  const [latestFrame, setLatestFrame] = useState<VisionFrame | null>(null);
  const [classifierError, setClassifierError] = useState<string | null>(null);
  const [statusToast, setStatusToast] = useState<string | null>(null);
  const [lastTtsLatencyMs, setLastTtsLatencyMs] = useState<number | null>(null);
  const [lastReconstructLatencyMs, setLastReconstructLatencyMs] = useState<
    number | null
  >(null);
  const [autoSpeakOnPreview, setAutoSpeakOnPreview] = useState<boolean>(true);

  // ----- mode controller lifecycle ------------------------------------------

  useEffect(() => {
    const { controller, release } = acquireController({ mode: "auto" });
    controllerRef.current = controller;
    releaseRef.current = release;
    log.info("bridge-active", "controller acquired", { mode: "auto" });
    return () => {
      controllerRef.current?.discard();
      controllerRef.current = null;
      const r = releaseRef.current;
      releaseRef.current = null;
      if (r) r();
      const m = mixerRef.current;
      mixerRef.current = null;
      if (m) m.dispose();
    };
  }, []);

  // ----- toggle Auto / Manual ------------------------------------------------

  const setMode = useCallback((mode: "auto" | "manual") => {
    controllerRef.current?.setMode(mode);
    setAutoSpeakOnPreview(mode === "auto");
  }, []);

  // ----- camera + classifier -------------------------------------------------

  const lifecycle = useClassifier({
    cameraDeviceId,
    modelOrigin: getModelOrigin(),
    onResult: (result) => controllerRef.current?.ingest(result),
    onFrame: (frame) => setLatestFrame(frame),
    onError: (message) => setClassifierError(message),
  });

  // ----- hearing-side STT ----------------------------------------------------

  useEffect(() => {
    if (credentials.status !== "ready") return;
    if (!loopbackInputDeviceId) return;
    if (!credentials.sttSignedUrl) return;

    let cancelled = false;
    let activeStream: SttStream | null = null;
    let activeLoopback: BridgeSystemAudio | null = null;

    void (async () => {
      try {
        const loopback = await openBridgeSystemAudio({
          inputDeviceId: loopbackInputDeviceId,
        });
        if (cancelled) {
          loopback.stop();
          return;
        }
        activeLoopback = loopback;
        loopbackRef.current = loopback;
        loopback.onEnded(() => {
          log.warn("bridge-active", "loopback track ended unexpectedly");
          setStatusToast("Loopback device disconnected — reconfigure if needed.");
        });

        const sttUrl = credentials.sttSignedUrl;
        if (!sttUrl) return;
        const stream = createSttStream({
          signedUrl: sttUrl,
          audioStream: loopback.stream,
          speaker: HEARING_PARTICIPANT,
          onPartial: (event) => {
            HearingTranscript.setLatestPartial(event.text);
          },
          onFinal: (event) => {
            HearingTranscript.appendHearingFinal(event.text);
          },
          onError: (event) => {
            if (event.fatal) {
              setStatusToast(`Captions unavailable: ${event.message}`);
            }
          },
        });
        if (cancelled) {
          loopback.stop();
          return;
        }
        activeStream = stream;
        sttStreamRef.current = stream;
        await stream.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("bridge-active", "stt setup failed", { message });
        setStatusToast(`Loopback capture failed: ${message}`);
      }
    })();

    return () => {
      cancelled = true;
      if (activeStream && sttStreamRef.current === activeStream) {
        sttStreamRef.current = null;
      }
      if (activeStream) void activeStream.stop();
      if (activeLoopback && loopbackRef.current === activeLoopback) {
        loopbackRef.current = null;
      }
      if (activeLoopback) activeLoopback.stop();
    };
  }, [
    credentials.status,
    credentials.sttSignedUrl,
    loopbackInputDeviceId,
  ]);

  // ----- stitching: OpenRouter reconstruct -----------------------------------

  useEffect(() => {
    if (snapshot.state !== "stitching") return;
    const controller = controllerRef.current;
    if (!controller) return;
    const epoch = controller.epoch();
    if (stitchEpochRef.current === epoch) return;
    stitchEpochRef.current = epoch;

    if (credentials.status !== "ready" || !credentials.openRouterApiKey) {
      controller.setLLMError("Credentials not ready");
      setStatusToast("LLM credentials still loading — try again in a moment.");
      return;
    }

    const apiKey = credentials.openRouterApiKey;
    const modelId = (credentials.openRouterModelId ??
      "openai/gpt-5.4-mini") as ReconstructionModelId;
    const tokens = controller.snapshot().buffer.tokens;
    const topK = tokens.map((tok) => ({
      word: tok.label,
      score: tok.score,
      alternatives: [],
    }));
    const recentDialog = HearingTranscript.recentDialog();

    const startedAt = performance.now();
    void (async () => {
      try {
        const result = await reconstruct({
          apiKey,
          modelId,
          recentDialog,
          topK,
        });
        if (controller.epoch() !== epoch) return;
        approveContextRef.current = {
          confidence: result.parsed.confidence,
          usedSigns: result.parsed.usedSigns,
        };
        setLastReconstructLatencyMs(
          Math.round(performance.now() - startedAt),
        );
        controller.setReconstruction(result.parsed);
      } catch (err) {
        if (controller.epoch() !== epoch) return;
        const message = err instanceof Error ? err.message : String(err);
        log.error("bridge-active", "reconstruct failed", { message });
        setStatusToast(`LLM unavailable: ${message}`);
        controller.setLLMError(message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state]);

  // ----- speaking: ElevenLabs WSS into BlackHole sink ------------------------

  useEffect(() => {
    if (snapshot.state !== "speaking") return;
    const controller = controllerRef.current;
    if (!controller) return;
    const epoch = controller.epoch();
    if (speakEpochRef.current === epoch) return;
    speakEpochRef.current = epoch;

    const sentence = controller.snapshot().speakingSentence;
    if (!sentence) {
      controller.speakingError("speakingSentence missing");
      return;
    }
    if (!credentials.ttsSignedUrl) {
      controller.speakingError("TTS URL not ready");
      setStatusToast("Voice URL still loading — try again in a moment.");
      return;
    }
    if (!micOutputDeviceId) {
      controller.speakingError("BlackHole mic device id missing");
      return;
    }

    const startedAt = performance.now();
    void (async () => {
      let mixer = mixerRef.current;
      if (!mixer) {
        try {
          mixer = createBridgeAudioSink({
            outputDeviceId: micOutputDeviceId,
          });
          mixerRef.current = mixer;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error("bridge-active", "audio sink create failed", { message });
          controller.speakingError(message);
          setStatusToast(`Couldn't open BlackHole 2ch: ${message}`);
          return;
        }
      }
      try {
        const wss = await openTurnWss(credentials.ttsSignedUrl!);
        if (controller.epoch() !== epoch) {
          wss.close();
          return;
        }
        await speak({
          wss,
          mixer,
          text: sentence,
          duckMic: false,
        });
        if (controller.epoch() !== epoch) {
          wss.close();
          return;
        }
        wss.close();
        setLastTtsLatencyMs(Math.round(performance.now() - startedAt));
        HearingTranscript.appendSelfFinal(sentence);
        controller.speakingDone();
        // Pre-mint the next URL so the next turn's WSS open is fast.
        void credentials.refreshTts();
      } catch (err) {
        if (controller.epoch() !== epoch) return;
        const message = err instanceof Error ? err.message : String(err);
        log.error("bridge-active", "speak failed", { message });
        if (looksLikeUrlExpiry(message)) {
          setStatusToast("Voice URL expired — re-sign and try again.");
          void credentials.refreshTts();
        } else {
          setStatusToast(`Voice interrupted: ${message}`);
        }
        controller.speakingError(message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.state]);

  // ----- approve handlers ----------------------------------------------------

  const handleApprove = useCallback((text: string) => {
    const c = controllerRef.current;
    if (!c) return;
    const preview = c.snapshot().preview;
    if (preview) {
      approveContextRef.current = {
        confidence: preview.confidence,
        usedSigns: preview.usedSigns,
      };
    }
    void mixerEnsureResume();
    c.approve(text);
  }, []);

  const handleResign = useCallback(() => {
    controllerRef.current?.resign();
  }, []);

  const handleDiscard = useCallback(() => {
    controllerRef.current?.discard();
  }, []);

  // ----- auto-approve in Auto mode -------------------------------------------

  // In Auto mode the controller emits state === "speaking" directly from
  // `setReconstruction`. Manual mode emits state === "preview" and waits for
  // user input. Nothing to wire here beyond the mode setter.

  // ----- mixerEnsureResume helper --------------------------------------------

  async function mixerEnsureResume(): Promise<void> {
    if (!mixerRef.current) return;
    try {
      await mixerRef.current.resume();
    } catch (err) {
      log.warn("bridge-active", "audio resume threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ----- toast auto-dismiss --------------------------------------------------

  useEffect(() => {
    if (!statusToast) return;
    const t = setTimeout(() => setStatusToast(null), 4500);
    return () => clearTimeout(t);
  }, [statusToast]);

  // ----- render --------------------------------------------------------------

  return (
    <div className="flex h-full flex-col bg-zinc-950 text-zinc-100">
      <Header
        mode={snapshot.mode}
        onModeChange={setMode}
        credentialsStatus={credentials.status}
        autoSpeakOnPreview={autoSpeakOnPreview}
      />

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto px-6 pb-4 pt-4">
        <div className="mx-auto w-full max-w-2xl">
          <CameraView stream={lifecycle.stream} frame={latestFrame} />
        </div>

        <div className="mx-auto w-full max-w-2xl space-y-4">
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-4">
            <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
              {snapshot.state === "capturing"
                ? "Capturing — admitted signs"
                : snapshot.state === "speaking"
                  ? "Speaking…"
                  : snapshot.state === "stitching"
                    ? "Reconstructing sentence…"
                    : snapshot.state === "preview"
                      ? "Preview"
                      : "Idle — sign to start"}
            </h3>
            <TokenChips tokens={snapshot.buffer.tokens} />
          </div>

          {snapshot.state === "preview" && snapshot.preview ? (
            <PreviewCard
              preview={snapshot.preview}
              onApprove={handleApprove}
              onResign={handleResign}
              onDiscard={handleDiscard}
            />
          ) : null}

          <CaptionStrip
            partial={transcript.latestPartial}
            recentFinals={transcript.hearing}
          />

          {classifierError ? (
            <div className="rounded border border-rose-700/50 bg-rose-900/20 p-2 text-xs text-rose-200">
              Classifier: {classifierError}
            </div>
          ) : null}
          {credentials.status === "error" && credentials.error ? (
            <div className="rounded border border-rose-700/50 bg-rose-900/20 p-2 text-xs text-rose-200">
              Credentials: {credentials.error}
            </div>
          ) : null}
        </div>
      </main>

      <Footer
        micOutputDeviceId={micOutputDeviceId}
        loopbackInputDeviceId={loopbackInputDeviceId}
        modelId={credentials.openRouterModelId}
        lastTtsLatencyMs={lastTtsLatencyMs}
        lastReconstructLatencyMs={lastReconstructLatencyMs}
        onReconfigure={onReconfigure}
      />

      {statusToast ? (
        <div className="pointer-events-none fixed inset-x-4 top-12 z-50 mx-auto max-w-md rounded-md border border-amber-700/60 bg-amber-900/80 px-3 py-2 text-xs text-amber-100 shadow-lg">
          {statusToast}
        </div>
      ) : null}
    </div>
  );
}

interface HeaderProps {
  mode: "auto" | "manual";
  onModeChange(mode: "auto" | "manual"): void;
  credentialsStatus: "loading" | "ready" | "error";
  autoSpeakOnPreview: boolean;
}

function Header({
  mode,
  onModeChange,
  credentialsStatus,
  autoSpeakOnPreview,
}: HeaderProps): JSX.Element {
  const credChip =
    credentialsStatus === "ready"
      ? { label: "credentials ok", color: "bg-emerald-500/15 text-emerald-300" }
      : credentialsStatus === "loading"
        ? { label: "credentials loading", color: "bg-amber-500/15 text-amber-300" }
        : { label: "credentials error", color: "bg-rose-500/15 text-rose-200" };

  return (
    <header
      className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-5 pb-3 pt-9"
      style={{ WebkitAppRegion: "drag" }}
    >
      <div className="ml-20 flex items-center gap-2 text-sm font-semibold text-zinc-100">
        Sign Chat Bridge
      </div>
      <div
        className="flex items-center gap-2 text-xs"
        style={{ WebkitAppRegion: "no-drag" }}
      >
        <span
          className={cn(
            "rounded-full px-2 py-0.5 font-medium",
            credChip.color,
          )}
        >
          {credChip.label}
        </span>
        <div className="flex overflow-hidden rounded-md border border-zinc-700">
          <button
            type="button"
            onClick={() => onModeChange("auto")}
            className={cn(
              "px-2 py-1 font-medium",
              mode === "auto"
                ? "bg-indigo-500 text-white"
                : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800",
            )}
            title={
              autoSpeakOnPreview
                ? "Auto: stitched sentences play immediately."
                : "Auto: stitched sentences play immediately."
            }
          >
            Auto
          </button>
          <button
            type="button"
            onClick={() => onModeChange("manual")}
            className={cn(
              "px-2 py-1 font-medium",
              mode === "manual"
                ? "bg-indigo-500 text-white"
                : "bg-zinc-900 text-zinc-300 hover:bg-zinc-800",
            )}
            title="Manual: each stitched sentence waits for Approve."
          >
            Manual
          </button>
        </div>
      </div>
    </header>
  );
}

interface CaptionStripProps {
  partial: string | null;
  recentFinals: Array<{ text: string }>;
}

function CaptionStrip({ partial, recentFinals }: CaptionStripProps): JSX.Element {
  const lastFinal = recentFinals[recentFinals.length - 1] ?? null;
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3 text-xs">
      <header className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">
        Hearing user (live captions)
      </header>
      {partial ? (
        <p className="text-zinc-100">
          <span className="text-zinc-400">… </span>
          {partial}
        </p>
      ) : lastFinal ? (
        <p className="text-zinc-300">{lastFinal.text}</p>
      ) : (
        <p className="text-zinc-500">
          Waiting for audio. Make sure Zoom's speaker is set to "Bridge
          Loopback".
        </p>
      )}
    </section>
  );
}

interface FooterProps {
  micOutputDeviceId: string;
  loopbackInputDeviceId: string;
  modelId: string | null;
  lastTtsLatencyMs: number | null;
  lastReconstructLatencyMs: number | null;
  onReconfigure(): void;
}

function Footer({
  micOutputDeviceId,
  loopbackInputDeviceId,
  modelId,
  lastTtsLatencyMs,
  lastReconstructLatencyMs,
  onReconfigure,
}: FooterProps): JSX.Element {
  return (
    <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 bg-zinc-900/60 px-4 py-2 text-[11px] text-zinc-400">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span title="Microphone (Zoom subscribes to this)">
          mic <code className="text-zinc-300">{shortId(micOutputDeviceId)}</code>
        </span>
        <span title="Loopback (Bridge transcribes from this)">
          loopback{" "}
          <code className="text-zinc-300">{shortId(loopbackInputDeviceId)}</code>
        </span>
        <span title="OpenRouter model used for stitching">
          {modelId ?? "model …"}
        </span>
        {lastReconstructLatencyMs !== null ? (
          <span>llm {lastReconstructLatencyMs} ms</span>
        ) : null}
        {lastTtsLatencyMs !== null ? (
          <span>tts {lastTtsLatencyMs} ms</span>
        ) : null}
      </div>
      <button
        type="button"
        onClick={onReconfigure}
        className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300 hover:bg-zinc-800"
      >
        Reconfigure
      </button>
    </footer>
  );
}

function shortId(id: string): string {
  if (!id) return "(none)";
  if (id === "default") return "default";
  return id.slice(0, 6);
}

function looksLikeUrlExpiry(message: string): boolean {
  return (
    /\b(401|403)\b/.test(message) ||
    /\b(expired|unauthorized|forbidden|invalid[_ ]token)\b/i.test(message)
  );
}

/**
 * Where the classifier static assets (`asl-signs.onnx` + label JSON)
 * are served. In dev that's the apps/web Next dev server; in production
 * Bridge points at signchat.org. Same env var as the credentials base
 * URL so a single override flips both.
 */
function getModelOrigin(): string {
  const fromEnv =
    typeof import.meta !== "undefined" &&
    typeof import.meta.env !== "undefined"
      ? (import.meta.env as Record<string, string | undefined>)
          .VITE_SIGNCHAT_API_BASE
      : undefined;
  return (fromEnv?.trim() || "https://signchat.org").replace(/\/$/, "");
}
