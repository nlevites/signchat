"use client";

import { useEffect, useRef, useState } from "react";
import {
  AudioPresets,
  ConnectionState,
  type LocalTrackPublication,
  Track,
} from "livekit-client";
import { LogBus } from "@/lib/diagnostics/log-bus";
import {
  mark,
  newTurnId,
  useLatencyStats,
} from "@/lib/diagnostics/latency-markers";
import { useCredentials } from "@/lib/credentials/store";
import {
  type Classifier,
  type ClassifierResult,
  type ClassifierState,
} from "@/lib/sign-pipeline/classifier";
import {
  DEFAULT_CLASSIFIER_CONFIG,
  MediaPipeOnnxClassifier,
} from "@/lib/sign-pipeline/mediapipe-onnx-classifier";
import {
  createScriptedClassifier,
  SCRIPTED_TIMELINES,
} from "@/lib/sign-pipeline/scripted-classifier";
import type { VisionFrame } from "@/lib/sign-pipeline/mediapipe-runner";
import {
  acquireController,
  useModeSnapshot,
} from "@/lib/mode-controller/controller-store";
import type { ModeController } from "@/lib/mode-controller/mode-controller";
import { reconstruct } from "@/lib/openrouter/client";
import {
  createVoiceMixer,
  type VoiceMixer,
} from "@/lib/audio/voice-mixer";
import { openTurnWss, speak } from "@/lib/elevenlabs/streaming";
import { useRoomState, RoomStore } from "@/lib/livekit/room-store";
import { broadcastCaption } from "@/lib/livekit/caption-broadcast";
import type { CaptureMode, ParticipantInfo } from "@/lib/contracts";
import { CameraPreview } from "@/components/primitives/camera-preview";

/**
 * Phase 6 — End-to-end Deaf-side turn.
 *
 * Composes phases 2/3/4/5 by wiring:
 *   Source (scripted timeline | live MediaPipe+ONNX) -> ClassifierResult ->
 *   ModeController (§9 FSM, §9.3 admit) -> Stitching -> reconstruct (Phase 3)
 *   -> Preview (§5.6 inline UX) -> Approve -> Speaking -> speak (Phase 4)
 *   -> mixer publish to signchat-voice (§8.2) + broadcast §11.4 caption
 *   at first audible sample.
 *
 * Failure-mode toggles inject errors at each stage to verify the FSM
 * follows the §7 reliability table (drop buffer, never broadcast partial
 * captions).
 */

const MODE_STORAGE_KEY = "signchat:mode";
const MODEL_STORAGE_KEY = "signchat:model-id";
const DEFAULT_MODEL_ID = "google/gemini-3.1-flash-lite-preview";

type Source = "scripted" | "live";

const STATE_PALETTE: Record<string, string> = {
  idle: "border-slate-600 bg-slate-700/30 text-slate-300",
  capturing: "border-sky-500/40 bg-sky-500/10 text-sky-200",
  stitching: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  preview: "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200",
  speaking: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
};

const CONFIDENCE_PALETTE: Record<"high" | "medium" | "low", string> = {
  high: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  low: "border-rose-500/40 bg-rose-500/10 text-rose-200",
};

interface LatencyRow {
  stage: string;
  label: string;
  /** §13 budget (p50, p95) in ms; null when no formal budget. */
  budgetP50: number | null;
  budgetP95: number | null;
}

const LATENCY_ROWS: ReadonlyArray<LatencyRow> = [
  { stage: "openrouter.reconstruct", label: "OpenRouter reconstruct", budgetP50: 600, budgetP95: 1200 },
  { stage: "tts.wss.open", label: "TTS WSS open", budgetP50: null, budgetP95: null },
  { stage: "tts.firstByte", label: "TTS first byte", budgetP50: 150, budgetP95: 350 },
  { stage: "tts.firstAudible", label: "TTS first audible", budgetP50: null, budgetP95: null },
  { stage: "tts.turnEnd", label: "TTS turn end", budgetP50: null, budgetP95: null },
  { stage: "e2e.turn", label: "E2E sign-end -> first audible", budgetP50: 950, budgetP95: 1600 },
];

interface FailureToggles {
  llm: boolean;
  tts: boolean;
  budget: boolean;
}

export function EndToEndPane() {
  const credentials = useCredentials();
  const roomState = useRoomState();
  const snapshot = useModeSnapshot();

  const [source, setSource] = useState<Source>("scripted");
  const [timelineId, setTimelineId] = useState<string>(SCRIPTED_TIMELINES[0]!.id);
  const [editText, setEditText] = useState<string>("");
  const [editing, setEditing] = useState<boolean>(false);
  const [failures, setFailures] = useState<FailureToggles>({
    llm: false,
    tts: false,
    budget: false,
  });
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [frame, setFrame] = useState<VisionFrame | null>(null);
  const [classifierState, setClassifierState] = useState<ClassifierState>("idle");
  const [classifierError, setClassifierError] = useState<string | null>(null);
  const [lastCaption, setLastCaption] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() =>
    typeof window === "undefined" ? 0 : Date.now(),
  );

  const controllerRef = useRef<ModeController | null>(null);
  const releaseControllerRef = useRef<(() => void) | null>(null);
  const classifierRef = useRef<Classifier | null>(null);
  const mixerRef = useRef<VoiceMixer | null>(null);
  const mixedPubRef = useRef<LocalTrackPublication | null>(null);
  const stitchEpochRef = useRef<number>(-1);
  const speakEpochRef = useRef<number>(-1);
  const turnStartedAtRef = useRef<number>(0);
  const turnIdRef = useRef<string>("");

  // Acquire the controller on mount, release on unmount.
  useEffect(() => {
    const initialMode: CaptureMode =
      typeof window !== "undefined" &&
      window.localStorage.getItem(MODE_STORAGE_KEY) === "manual"
        ? "manual"
        : "auto";
    const { controller, release } = acquireController({ mode: initialMode });
    controllerRef.current = controller;
    releaseControllerRef.current = release;
    LogBus.debug("e2e", "end-to-end pane mounted", { mode: initialMode });
    return () => {
      const r = releaseControllerRef.current;
      releaseControllerRef.current = null;
      controllerRef.current = null;
      if (r) r();
      const cls = classifierRef.current;
      classifierRef.current = null;
      if (cls) void cls.stop();
      const pub = mixedPubRef.current;
      mixedPubRef.current = null;
      const room = roomState.room;
      if (pub && room && pub.track) {
        try {
          void room.localParticipant.unpublishTrack(pub.track);
        } catch {
          // ignore
        }
      }
      const m = mixerRef.current;
      mixerRef.current = null;
      if (m) m.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tick 4×/sec so the silence-timer countdown updates without calling
  // Date.now() during render (React compiler enforces purity).
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 250);
    return () => clearInterval(id);
  }, []);

  // Build / rebuild the classifier when source or timelineId changes.
  // Don't call setState synchronously in the effect body — the new
  // classifier's onStateChange / onStream / onFrame callbacks drive the
  // UI as external events.
  useEffect(() => {
    let cancelled = false;
    const previous = classifierRef.current;
    classifierRef.current = null;

    void (async () => {
      if (previous) {
        try {
          await previous.stop();
        } catch {
          // ignore
        }
      }
      if (cancelled) return;
      let next: Classifier;
      if (source === "scripted") {
        const timeline =
          SCRIPTED_TIMELINES.find((t) => t.id === timelineId) ??
          SCRIPTED_TIMELINES[0]!;
        next = createScriptedClassifier(timeline);
      } else {
        next = new MediaPipeOnnxClassifier({
          config: { inferenceIntervalMs: DEFAULT_CLASSIFIER_CONFIG.inferenceIntervalMs },
          onStream: setStream,
          onFrame: setFrame,
        });
      }
      next.onStateChange((s, err) => {
        setClassifierState(s);
        if (err) setClassifierError(err.message);
      });
      next.onResult((result: ClassifierResult) => {
        controllerRef.current?.ingest(result);
      });
      classifierRef.current = next;
      // Live source: kick the classifier on so the camera + model boot
      // happen up-front rather than when the user clicks Start.
      if (source === "live") {
        try {
          await next.start();
        } catch (err) {
          if (cancelled) return;
          setClassifierError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [source, timelineId]);

  // Trigger reconstruct on Stitching transitions.
  useEffect(() => {
    if (snapshot.state !== "stitching") return;
    const controller = controllerRef.current;
    if (!controller) return;
    const epoch = controller.epoch();
    if (stitchEpochRef.current === epoch) return; // already triggered for this turn
    stitchEpochRef.current = epoch;

    if (failures.budget) {
      LogBus.warn("e2e", "force_session_budget — controller locks");
      controller.setLLMError("Session budget exhausted — refresh or open a new room");
      return;
    }
    if (failures.llm) {
      LogBus.warn("e2e", "force_llm_error — dropping buffer");
      controller.setLLMError("forced llm_unavailable");
      return;
    }

    const apiKey = credentials.openrouter?.apiKey;
    if (!apiKey) {
      controller.setLLMError("No OpenRouter session key — mint in the Lobby");
      return;
    }

    turnStartedAtRef.current = performance.now();
    turnIdRef.current = newTurnId();
    mark("e2e.turn", turnIdRef.current, "start");

    const modelId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL_ID
        : DEFAULT_MODEL_ID;
    const tokens = controller.snapshot().buffer.tokens;
    const topK = tokens.map((tok) => ({
      word: tok.label,
      score: tok.score,
      alternatives: [],
    }));

    void (async () => {
      try {
        const result = await reconstruct({
          apiKey,
          modelId,
          hearingTranscript: "",
          topK,
        });
        if (controller.epoch() !== epoch) {
          LogBus.debug("e2e", "stale reconstruct result dropped (epoch mismatch)");
          return;
        }
        controller.setReconstruction(result.parsed);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (controller.epoch() !== epoch) return;
        controller.setLLMError(message);
      }
    })();
  }, [snapshot.state, failures.budget, failures.llm, failures.tts, credentials.openrouter]);

  // Stash preview metadata at the moment of approve so the speaking effect
  // can populate the broadcast caption with the right confidence + usedSigns.
  const approveContextRef = useRef<{
    confidence: "high" | "medium" | "low";
    usedSigns: string[];
  } | null>(null);

  // Trigger speak on Speaking transitions.
  useEffect(() => {
    if (snapshot.state !== "speaking") return;
    const controller = controllerRef.current;
    if (!controller) return;
    const epoch = controller.epoch();
    if (speakEpochRef.current === epoch) return;
    speakEpochRef.current = epoch;

    if (failures.tts) {
      LogBus.warn("e2e", "force_tts_error — dropping turn without broadcast");
      controller.speakingError("forced tts_unavailable");
      return;
    }

    const signedUrl = credentials.elevenlabs?.signedUrl;
    if (!signedUrl) {
      controller.speakingError("No ElevenLabs signed URL — mint in the Lobby");
      return;
    }
    const sentence = controller.snapshot().speakingSentence;
    if (!sentence) {
      controller.speakingError("speakingSentence missing");
      return;
    }
    const livekitConnected =
      roomState.state === ConnectionState.Connected && roomState.room !== null;
    const modelId =
      typeof window !== "undefined"
        ? window.localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL_ID
        : DEFAULT_MODEL_ID;
    const lastConfidence = approveContextRef.current?.confidence ?? "high";
    const lastUsedSigns = approveContextRef.current?.usedSigns ?? [];
    const turnStartedAtPerf = performance.now();

    void (async () => {
      const mixer = ensureMixer(mixerRef);
      let wss: Awaited<ReturnType<typeof openTurnWss>> | null = null;
      try {
        mixer.setMonitorEnabled(!livekitConnected);
        if (livekitConnected) {
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
            mixer.attachMic(stream);
          } catch (err) {
            LogBus.warn("e2e", "mic acquire failed; continuing without duck", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          await ensureMixedPublished(mixer, mixedPubRef);
        }

        wss = await openTurnWss(signedUrl);
        if (controller.epoch() !== epoch) return;

        await speak({
          wss,
          mixer,
          text: sentence,
          duckMic: livekitConnected,
          onFirstAudible: (firstAudibleAt) => {
            if (controller.epoch() !== epoch) return;
            const rs = RoomStore.snapshot();
            if (!rs.room || !rs.local) return;
            const from: ParticipantInfo = {
              identity: rs.local.identity,
              name: rs.local.name,
              role: rs.local.role ?? "deaf",
            };
            const latencyMs = Math.round(performance.now() - turnStartedAtPerf);
            void broadcastCaption({
              room: rs.room,
              audioCtx: mixer.audioCtx,
              firstAudibleAt,
              from,
              sentence,
              confidence: lastConfidence,
              usedSigns: lastUsedSigns,
              modelId,
              latencyMs,
            }).then(
              () => setLastCaption(sentence),
              () => {
                // already logged inside broadcastCaption
              },
            );
          },
        });

        if (controller.epoch() !== epoch) return;
        const tid = turnIdRef.current;
        if (tid) mark("e2e.turn", tid, "end");
        controller.speakingDone();
      } catch (err) {
        if (controller.epoch() !== epoch) return;
        const message = err instanceof Error ? err.message : String(err);
        controller.speakingError(message);
      } finally {
        if (wss) {
          try {
            wss.close();
          } catch {
            // ignore
          }
        }
      }
    })();
  }, [
    snapshot.state,
    failures.tts,
    credentials.elevenlabs,
    roomState.room,
    roomState.state,
  ]);

  const onSetMode = (mode: CaptureMode) => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_STORAGE_KEY, mode);
    }
    controllerRef.current?.setMode(mode);
  };

  const onStart = async () => {
    const c = controllerRef.current;
    if (!c) return;
    setLastCaption(null);
    c.start();
    if (source === "scripted") {
      // Scripted classifier needs an explicit replay each turn.
      const cls = classifierRef.current;
      if (cls) {
        try {
          await cls.stop();
          await cls.start();
        } catch {
          // ignore
        }
      }
    }
  };

  const onApprove = (text: string) => {
    const c = controllerRef.current;
    if (!c) return;
    const preview = c.snapshot().preview;
    if (preview) {
      approveContextRef.current = {
        confidence: preview.confidence,
        usedSigns: preview.usedSigns,
      };
    }
    setEditing(false);
    c.approve(text);
  };

  // ------------------------ render -------------------------------------------

  const stateClass = STATE_PALETTE[snapshot.state] ?? STATE_PALETTE.idle ?? "";
  const isHearingRole = credentials.context?.role === "hearing";
  const hasOpenRouter = Boolean(credentials.openrouter?.apiKey);
  const hasElevenLabs = Boolean(credentials.elevenlabs?.signedUrl);
  const livekitConnected = roomState.state === ConnectionState.Connected;
  const canStart =
    snapshot.state === "idle" &&
    hasOpenRouter &&
    hasElevenLabs &&
    !isHearingRole &&
    classifierState !== "error";

  const silenceWaitMs =
    snapshot.state === "capturing" &&
    snapshot.mode === "auto" &&
    snapshot.buffer.lastAdmitAt &&
    nowMs > 0
      ? Math.max(
          0,
          snapshot.thresholds.silenceMs - (nowMs - snapshot.enteredStateAt),
        )
      : null;

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-semibold text-slate-100">
            End-to-end Deaf-side turn
          </h2>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
            Phase 6 — live
          </span>
          <span
            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${stateClass}`}
          >
            {snapshot.state}
          </span>
          <ChipBadge ok={hasOpenRouter} label="OR key" />
          <ChipBadge ok={hasElevenLabs} label="EL url" />
          <ChipBadge ok={livekitConnected} label="LiveKit" />
        </div>
        {isHearingRole ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            End-to-end Deaf turn is only available with role
            <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5">deaf</code>.
            Switch role in the Lobby and re-mint.
          </p>
        ) : !hasOpenRouter || !hasElevenLabs ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            Need both OpenRouter and ElevenLabs creds. Mint them in the Lobby
            with role=deaf.
          </p>
        ) : (
          <p className="text-sm text-slate-400">
            Composes Sign capture (Phase 5) → Mode controller (§9) → OpenRouter
            (Phase 3) → Inline preview (§5.6) → ElevenLabs (Phase 4) →
            signchat-voice publish (§8.2) → §11.4 caption broadcast.
          </p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <ModeSegmented
            mode={snapshot.mode}
            onChange={onSetMode}
          />
          <button
            type="button"
            onClick={() => void onStart()}
            disabled={!canStart}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start
          </button>
          {snapshot.state === "capturing" && snapshot.mode === "manual" ? (
            <>
              <button
                type="button"
                onClick={() => controllerRef.current?.stopManual()}
                disabled={snapshot.buffer.tokens.length === 0}
                className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-1.5 text-sm text-sky-200 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Stop
              </button>
              <button
                type="button"
                onClick={() => controllerRef.current?.cancel()}
                className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
            </>
          ) : null}
          {snapshot.state === "capturing" && snapshot.mode === "auto" && silenceWaitMs !== null ? (
            <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] tabular-nums text-amber-200">
              silence in {Math.ceil(silenceWaitMs / 100) / 10}s
            </span>
          ) : null}
          {snapshot.error ? (
            <span className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
              {snapshot.error}
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <SourcePanel
            source={source}
            onSourceChange={setSource}
            timelineId={timelineId}
            onTimelineChange={setTimelineId}
            stream={stream}
            frame={frame}
            classifierState={classifierState}
            classifierError={classifierError}
          />
        </div>
        <div className="space-y-4">
          <FailurePanel toggles={failures} onChange={setFailures} />
          <BroadcastPanel
            lastCaption={lastCaption}
            roomState={roomState.state}
          />
        </div>
      </div>

      {snapshot.state === "capturing" || snapshot.state === "stitching" ? (
        <BufferPanel tokens={snapshot.buffer.tokens} state={snapshot.state} />
      ) : null}

      {snapshot.state === "preview" && snapshot.preview ? (
        <PreviewPanel
          preview={snapshot.preview}
          editing={editing}
          editText={editText}
          onEditingChange={(v) => {
            setEditing(v);
            if (v) setEditText(snapshot.preview!.sentence);
          }}
          onEditTextChange={setEditText}
          onApprove={() =>
            onApprove(editing ? editText : snapshot.preview!.sentence)
          }
          onResign={() => controllerRef.current?.resign()}
          onDiscard={() => controllerRef.current?.discard()}
        />
      ) : null}

      <LatencyTable />
    </section>
  );
}

// ---- helpers ----------------------------------------------------------------

function ensureMixer(ref: { current: VoiceMixer | null }): VoiceMixer {
  if (!ref.current) {
    ref.current = createVoiceMixer();
  }
  return ref.current;
}

async function ensureMixedPublished(
  mixer: VoiceMixer,
  pubRef: { current: LocalTrackPublication | null },
): Promise<void> {
  if (pubRef.current) return;
  const rs = RoomStore.snapshot();
  if (!rs.room) return;
  const lp = rs.room.localParticipant;
  // §5.2 / §8.2: only one outgoing audio track. Unpublish any existing mic
  // before publishing the mixed signchat-voice track.
  for (const pub of lp.audioTrackPublications.values()) {
    if (pub.source === Track.Source.Microphone && pub.track) {
      try {
        await lp.unpublishTrack(pub.track, true);
      } catch {
        // ignore
      }
    }
  }
  pubRef.current = await lp.publishTrack(mixer.outputTrack, {
    source: Track.Source.Microphone,
    name: "signchat-voice",
    dtx: false,
    red: true,
    audioPreset: AudioPresets.speech,
  });
  LogBus.info("e2e", "published signchat-voice", {
    sid: pubRef.current.trackSid,
  });
}

// ---- subcomponents ----------------------------------------------------------

function ChipBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
        ok
          ? "border-sky-500/40 bg-sky-500/10 text-sky-200"
          : "border-slate-600 bg-slate-700/30 text-slate-400"
      }`}
    >
      {label}
    </span>
  );
}

function ModeSegmented({
  mode,
  onChange,
}: {
  mode: CaptureMode;
  onChange: (m: CaptureMode) => void;
}) {
  return (
    <div className="flex rounded-md border border-slate-700 bg-slate-900 p-1 text-xs">
      {(["auto", "manual"] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          className={[
            "px-3 py-1 transition-colors",
            mode === option
              ? "rounded bg-sky-500/20 text-sky-100"
              : "text-slate-400 hover:text-slate-200",
          ].join(" ")}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function SourcePanel({
  source,
  onSourceChange,
  timelineId,
  onTimelineChange,
  stream,
  frame,
  classifierState,
  classifierError,
}: {
  source: Source;
  onSourceChange: (s: Source) => void;
  timelineId: string;
  onTimelineChange: (id: string) => void;
  stream: MediaStream | null;
  frame: VisionFrame | null;
  classifierState: ClassifierState;
  classifierError: string | null;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">Source</h3>
        <span className="text-[11px] text-slate-500">
          classifier:{" "}
          <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">
            {classifierState}
          </code>
        </span>
      </div>
      <div className="mb-3 flex rounded-md border border-slate-700 bg-slate-900 p-1 text-xs">
        {(["scripted", "live"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onSourceChange(option)}
            className={[
              "flex-1 px-3 py-1.5 transition-colors",
              source === option
                ? "rounded bg-sky-500/20 text-sky-100"
                : "text-slate-400 hover:text-slate-200",
            ].join(" ")}
          >
            {option}
          </button>
        ))}
      </div>
      {source === "scripted" ? (
        <div className="space-y-2">
          <select
            value={timelineId}
            onChange={(e) => onTimelineChange(e.target.value)}
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-100"
          >
            {SCRIPTED_TIMELINES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} → {t.expected}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-slate-500">
            Hermetic timeline replay; ticks fire at {SCRIPTED_TIMELINES.find((t) => t.id === timelineId)?.tickMs ?? 500}ms.
            Ideal for failure-mode testing without the camera.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <CameraPreview stream={stream} frame={frame} />
          {classifierError ? (
            <p className="rounded-md border border-rose-500/40 bg-rose-500/10 p-2 text-xs text-rose-200">
              {classifierError}
            </p>
          ) : (
            <p className="text-[11px] text-slate-500">
              MediaPipe + ONNX feeding the same controller as scripted source.
              Sign for ~1 s to satisfy STABILITY_TICKS=2.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function FailurePanel({
  toggles,
  onChange,
}: {
  toggles: FailureToggles;
  onChange: (next: FailureToggles) => void;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-100">
        Failure-mode injection (§7)
      </h3>
      <div className="space-y-2 text-xs">
        <ToggleRow
          checked={toggles.llm}
          onChange={(v) => onChange({ ...toggles, llm: v })}
          label="force_llm_error"
          hint="Skip OpenRouter; controller drops buffer, returns to idle."
        />
        <ToggleRow
          checked={toggles.tts}
          onChange={(v) => onChange({ ...toggles, tts: v })}
          label="force_tts_error"
          hint="Skip ElevenLabs; controller surfaces tts_unavailable. No caption broadcast."
        />
        <ToggleRow
          checked={toggles.budget}
          onChange={(v) => onChange({ ...toggles, budget: v })}
          label="force_session_budget"
          hint="Surfaces 429 quota_exhausted toast; controller locks until reload."
        />
      </div>
    </div>
  );
}

function ToggleRow({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-3.5 w-3.5"
      />
      <div>
        <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-200">
          {label}
        </code>
        <p className="mt-0.5 text-[11px] text-slate-500">{hint}</p>
      </div>
    </label>
  );
}

function BroadcastPanel({
  lastCaption,
  roomState,
}: {
  lastCaption: string | null;
  roomState: ConnectionState;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">
        §11.4 caption broadcast
      </h3>
      <p className="mb-2 text-[11px] text-slate-500">
        room:{" "}
        <code className="rounded bg-slate-800 px-1 py-0.5">{roomState}</code>
      </p>
      {lastCaption ? (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 p-2 text-xs text-emerald-200">
          last: “{lastCaption}”
        </div>
      ) : (
        <p className="text-[11px] text-slate-500">
          {roomState === ConnectionState.Connected
            ? "no broadcast yet — complete a turn to see one."
            : "connect a LiveKit room (Phase 2) to broadcast captions."}
        </p>
      )}
    </div>
  );
}

function BufferPanel({
  tokens,
  state,
}: {
  tokens: ReadonlyArray<{ label: string; via: "stable" | "band"; score: number }>;
  state: string;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-sm font-semibold text-slate-100">
          Sign buffer ({state})
        </h3>
        <span className="text-[11px] text-slate-500">
          {tokens.length} {tokens.length === 1 ? "token" : "tokens"}
        </span>
      </div>
      {tokens.length === 0 ? (
        <p className="text-[11px] text-slate-500">
          waiting for admits — STABILITY_TICKS=2 means the same top-1 must
          appear on two consecutive ticks above top1Threshold.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {tokens.map((tok, i) => (
            <span
              key={`${tok.label}-${i}`}
              className={`rounded-full border px-2 py-0.5 font-mono text-[11px] tracking-wide ${
                tok.via === "stable"
                  ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-200"
              }`}
              title={`via ${tok.via} @ ${tok.score.toFixed(2)}`}
            >
              {tok.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function PreviewPanel({
  preview,
  editing,
  editText,
  onEditingChange,
  onEditTextChange,
  onApprove,
  onResign,
  onDiscard,
}: {
  preview: { sentence: string; confidence: "high" | "medium" | "low"; usedSigns: string[]; needsClarification?: boolean };
  editing: boolean;
  editText: string;
  onEditingChange: (v: boolean) => void;
  onEditTextChange: (text: string) => void;
  onApprove: () => void;
  onResign: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="rounded-xl border border-fuchsia-500/40 bg-fuchsia-500/5 p-6">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-fuchsia-100">Preview</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${CONFIDENCE_PALETTE[preview.confidence]}`}
        >
          {preview.confidence}
        </span>
        {preview.needsClarification ? (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200">
            needs clarification
          </span>
        ) : null}
      </div>
      {editing ? (
        <textarea
          value={editText}
          onChange={(e) => onEditTextChange(e.target.value)}
          rows={2}
          autoFocus
          className="mb-3 w-full rounded-md border border-fuchsia-500/40 bg-slate-900 px-2 py-1.5 font-mono text-base text-slate-100 outline-none focus:border-fuchsia-400"
        />
      ) : (
        <p className="mb-3 text-xl font-semibold text-slate-50">
          {preview.sentence}
        </p>
      )}
      {preview.usedSigns.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {preview.usedSigns.map((sign) => (
            <span
              key={sign}
              className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] tracking-wide text-fuchsia-200"
            >
              {sign}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onApprove}
          className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20"
        >
          Approve
        </button>
        <button
          type="button"
          onClick={() => onEditingChange(!editing)}
          className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
        >
          {editing ? "Cancel edit" : "Edit"}
        </button>
        <button
          type="button"
          onClick={onResign}
          className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-sm text-amber-200 hover:bg-amber-500/20"
        >
          Re-sign
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-sm text-rose-200 hover:bg-rose-500/20"
        >
          Discard
        </button>
      </div>
    </div>
  );
}

function LatencyTable() {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
      <h3 className="mb-2 text-sm font-semibold text-slate-100">
        Latency (vs §13 budgets)
      </h3>
      <table className="w-full text-xs">
        <thead className="border-b border-slate-700 text-left uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-1.5 font-medium">stage</th>
            <th className="py-1.5 text-right font-medium">last</th>
            <th className="py-1.5 text-right font-medium">p50</th>
            <th className="py-1.5 text-right font-medium">p95</th>
            <th className="py-1.5 text-right font-medium">budget p50/p95</th>
          </tr>
        </thead>
        <tbody>
          {LATENCY_ROWS.map((row) => (
            <LatencyTableRow key={row.stage} row={row} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LatencyTableRow({ row }: { row: LatencyRow }) {
  const stats = useLatencyStats(row.stage);
  const last = stats?.last ?? null;
  const p50 = stats?.p50 ?? null;
  const p95 = stats?.p95 ?? null;
  const overP50 =
    row.budgetP50 !== null && p50 !== null && p50 > row.budgetP50;
  const overP95 =
    row.budgetP95 !== null && p95 !== null && p95 > row.budgetP95;
  const rowClass = overP50 || overP95 ? "bg-rose-500/5" : "";
  return (
    <tr className={`border-b border-slate-800 ${rowClass}`}>
      <td className="py-1 font-mono text-slate-200">{row.stage}</td>
      <td className="py-1 text-right tabular-nums text-slate-300">
        {last !== null ? `${Math.round(last)}ms` : "—"}
      </td>
      <td className={`py-1 text-right tabular-nums ${overP50 ? "text-rose-200" : "text-slate-100"}`}>
        {p50 !== null ? `${Math.round(p50)}ms` : "—"}
      </td>
      <td className={`py-1 text-right tabular-nums ${overP95 ? "text-rose-200" : "text-slate-100"}`}>
        {p95 !== null ? `${Math.round(p95)}ms` : "—"}
      </td>
      <td className="py-1 text-right tabular-nums text-slate-500">
        {row.budgetP50 !== null && row.budgetP95 !== null
          ? `${row.budgetP50} / ${row.budgetP95}ms`
          : "—"}
      </td>
    </tr>
  );
}
