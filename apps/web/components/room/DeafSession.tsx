"use client";

import { useEffect, useRef } from "react";
import {
  AudioPresets,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type RemoteAudioTrack,
  type Room,
  Track,
} from "livekit-client";
import type {
  ParticipantInfo,
  ReconstructionPayload,
  RoomDataMessage,
} from "@signchat/contracts";
import {
  ReconstructionParseError,
  type ReconstructionModelId,
} from "@signchat/prompts";
import {
  acquireController,
  useModeSnapshot,
} from "@/lib/mode-controller/controller-store";
import type { ModeController } from "@/lib/mode-controller/mode-controller";
import { MediaPipeOnnxClassifier } from "@/lib/sign-pipeline/mediapipe-onnx-classifier";
import { reconstruct } from "@/lib/openrouter/client";
import {
  createVoiceMixer,
  type VoiceMixer,
} from "@/lib/audio/voice-mixer";
import { openTurnWss, speak } from "@/lib/elevenlabs/streaming";
import { broadcastCaption } from "@/lib/livekit/caption-broadcast";
import { mintElevenLabsSignedUrl } from "@/lib/livekit/mint-elevenlabs";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { useCredentialsStore } from "@/lib/credentials/store";
import {
  useDebugFlagsStore,
  useDebugSignalsStore,
  usePreferencesStore,
  useRoomStore,
  useTranscriptStore,
} from "@/lib/stores";
import { toast } from "@/lib/stores/toast";
import {
  createWhisperStream,
  type WhisperStream,
} from "@/lib/whisper/streaming";
import { TokenChipStrip } from "@/components/room/TokenChipStrip";
import { InlinePreview } from "@/components/room/InlinePreview";

/**
 * Headless orchestration for the Deaf user's signing turn (ARCHITECTURE.md
 * §5.6 / §6 / §7 / §8 / §9 / §11.4).
 *
 * Mounts inside <ActiveRoom> only when role === "deaf". Acquires a per-pane
 * mode controller and wires it together with:
 *   classifier (ingest)
 *   -> stitching: OpenRouter reconstruct
 *   -> preview: InlinePreview UX
 *   -> speaking: ElevenLabs WSS + signchat-voice publish + §11.4 caption
 *
 * The local camera track is borrowed from LiveKit's LocalVideoTrack via
 * `mediaStreamTrack`; we never re-acquire the camera with getUserMedia,
 * which would conflict with LiveKit's track ownership.
 */

const REMINT_THRESHOLD_MS = 30_000;
const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface DeafSessionProps {
  room: Room | null;
  localVideoTrack: LocalVideoTrack | null;
  remoteAudioTrack: RemoteAudioTrack | null;
  participantInfo: ParticipantInfo;
  hearingTranscriptContext: () => string[];
  /** Publish a RoomDataMessage on the LiveKit data channel. */
  publish: (msg: RoomDataMessage) => Promise<void>;
}

export function DeafSession({
  room,
  localVideoTrack,
  remoteAudioTrack,
  participantInfo,
  hearingTranscriptContext,
  publish,
}: DeafSessionProps) {
  const snapshot = useModeSnapshot();
  const credentials = useCredentialsStore();
  const prefs = usePreferencesStore();
  const connectionState = useRoomStore((s) => s.connectionState);
  const roomId = useRoomStore((s) => s.roomId);
  const identity = useRoomStore((s) => s.identity);
  const remoteParticipant = useRoomStore((s) => s.remoteParticipant);
  const setElevenLabs = useCredentialsStore((s) => s.setElevenLabs);

  const controllerRef = useRef<ModeController | null>(null);
  const releaseControllerRef = useRef<(() => void) | null>(null);
  const classifierRef = useRef<MediaPipeOnnxClassifier | null>(null);
  const mixerRef = useRef<VoiceMixer | null>(null);
  const mixedPubRef = useRef<LocalTrackPublication | null>(null);
  const whisperStreamRef = useRef<WhisperStream | null>(null);
  const stitchEpochRef = useRef<number>(-1);
  const speakEpochRef = useRef<number>(-1);
  const wasSpeakingWhenHiddenRef = useRef<boolean>(false);
  const turnIdRef = useRef<string>("");
  const turnStartedAtPerfRef = useRef<number>(0);
  const approveContextRef = useRef<{
    confidence: ReconstructionPayload["confidence"];
    usedSigns: string[];
  } | null>(null);
  // Snapshot the current room reference so the unmount cleanup can unpublish
  // even after the room prop has been nulled by an unmount-during-disconnect.
  const roomRef = useRef<Room | null>(room);
  roomRef.current = room;
  // Latch the most recent transcript getter so the stitching effect doesn't
  // re-run every time the parent rebinds the callback.
  const transcriptCtxRef = useRef(hearingTranscriptContext);
  transcriptCtxRef.current = hearingTranscriptContext;
  // Latch publish so the whisper-stream effect doesn't tear down when the
  // parent rebinds the callback.
  const publishRef = useRef(publish);
  publishRef.current = publish;
  // Latch participantInfo so the stitching/speaking effects don't have to
  // depend on a fresh object identity every parent render.
  const participantInfoRef = useRef(participantInfo);
  participantInfoRef.current = participantInfo;

  // ----- controller lifecycle ------------------------------------------------

  useEffect(() => {
    const { controller, release } = acquireController({ mode: prefs.mode });
    controllerRef.current = controller;
    releaseControllerRef.current = release;
    LogBus.debug("deaf-session", "mounted", { mode: prefs.mode });
    return () => {
      const cls = classifierRef.current;
      classifierRef.current = null;
      if (cls) void cls.stop();

      const c = controllerRef.current;
      if (c) c.discard();
      controllerRef.current = null;

      const pub = mixedPubRef.current;
      mixedPubRef.current = null;
      const r = roomRef.current;
      if (pub && r && pub.track) {
        try {
          void r.localParticipant.unpublishTrack(pub.track, true);
        } catch {
          // ignore
        }
      }

      const m = mixerRef.current;
      mixerRef.current = null;
      if (m) m.dispose();

      const rel = releaseControllerRef.current;
      releaseControllerRef.current = null;
      if (rel) rel();
      LogBus.debug("deaf-session", "unmounted");
    };
    // Acquire/release exactly once per mount; mode changes propagate via the
    // dedicated effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Push preference changes into the controller without re-acquiring it.
  useEffect(() => {
    controllerRef.current?.setMode(prefs.mode);
  }, [prefs.mode]);

  useEffect(() => {
    controllerRef.current?.setThresholds({
      top1Threshold: prefs.thresholds.top1Threshold,
      top2Threshold: prefs.thresholds.top2Threshold,
      silenceMs: prefs.thresholds.silenceMs,
      inferenceIntervalMs: prefs.thresholds.intervalMs,
    });
  }, [prefs.thresholds]);

  // ----- classifier on the LiveKit camera track ------------------------------

  useEffect(() => {
    if (!localVideoTrack) return;
    const mst = localVideoTrack.mediaStreamTrack;
    if (!mst) return;
    const stream = new MediaStream([mst]);
    const debugStore = useDebugSignalsStore.getState();
    debugStore.setCameraStream(stream);
    const cls = new MediaPipeOnnxClassifier({
      config: { inferenceIntervalMs: prefs.thresholds.intervalMs },
      stream,
      onFrame: (frame) => useDebugSignalsStore.getState().setLatestFrame(frame),
    });
    const offResult = cls.onResult((result) => {
      controllerRef.current?.ingest(result);
      useDebugSignalsStore.getState().setLatestResult(result);
    });
    const offState = cls.onStateChange((state, err) => {
      if (err) {
        LogBus.warn("deaf-session", "classifier error", {
          state,
          error: err.message,
        });
      } else {
        LogBus.debug("deaf-session", "classifier state", { state });
      }
    });
    classifierRef.current = cls;
    void cls.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      LogBus.error("deaf-session", "classifier start failed", { message });
      toast.error("Sign classifier unavailable");
    });

    return () => {
      offResult();
      offState();
      if (classifierRef.current === cls) classifierRef.current = null;
      void cls.stop();
      useDebugSignalsStore.getState().reset();
    };
    // intervalMs is intentionally NOT a dep — runtime cadence is mutated via
    // the classifier's setter rather than a full restart.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localVideoTrack]);

  // ----- whisper streaming on the Hearing user's audio track -----------------

  useEffect(() => {
    if (!remoteAudioTrack) return;
    if (remoteParticipant?.role !== "hearing") return;
    const speaker = remoteParticipant;
    const stream = createWhisperStream({
      modelId: prefs.whisperModelId,
      remoteAudioTrack,
      speaker,
      publish: (msg) => publishRef.current(msg),
    });
    whisperStreamRef.current = stream;
    void stream.start().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      LogBus.error("deaf-session", "whisper stream start failed", { message });
    });
    return () => {
      if (whisperStreamRef.current === stream) whisperStreamRef.current = null;
      void stream.stop();
    };
    // whisperModelId is excluded — switching the variant requires a hard
    // reload anyway (the lobby prewarms a single variant per session).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteAudioTrack, remoteParticipant]);

  // ----- stitching: OpenRouter reconstruct -----------------------------------

  useEffect(() => {
    if (snapshot.state !== "stitching") return;
    const controller = controllerRef.current;
    if (!controller) return;
    const epoch = controller.epoch();
    if (stitchEpochRef.current === epoch) return;
    stitchEpochRef.current = epoch;

    const flags = useDebugFlagsStore.getState();
    if (flags.forceSessionBudget) {
      toast.error("Session budget exhausted — refresh or open a new room");
      controller.setLLMError("forced session_budget_exhausted");
      return;
    }
    if (flags.forceLLMError) {
      toast.error("LLM unavailable");
      controller.setLLMError("forced llm_unavailable");
      return;
    }

    // Read store values via getState() so the effect doesn't have to
    // depend on subscribed credentials/prefs — the controller's epoch
    // guard handles the case where those mutate during reconstruct().
    const credSnap = useCredentialsStore.getState();
    const prefSnap = usePreferencesStore.getState();
    const apiKey = credSnap.openrouter?.apiKey;
    if (!apiKey) {
      controller.setLLMError("OpenRouter session key missing");
      toast.error("LLM unavailable");
      return;
    }
    const modelId = (credSnap.openrouter?.modelId ??
      prefSnap.modelId) as ReconstructionModelId;

    turnIdRef.current = newTurnId();
    turnStartedAtPerfRef.current = performance.now();
    mark("e2e.turn", turnIdRef.current, "start");

    const tokens = controller.snapshot().buffer.tokens;
    const topK = tokens.map((tok) => ({
      word: tok.label,
      score: tok.score,
      alternatives: [],
    }));
    const hearingTranscript = transcriptCtxRef.current().join(" ").trim();

    const attempt = async (isRetry: boolean): Promise<void> => {
      try {
        const result = await reconstruct({
          apiKey,
          modelId,
          hearingTranscript,
          topK,
        });
        if (controller.epoch() !== epoch) {
          LogBus.debug("deaf-session", "stale reconstruct dropped");
          return;
        }
        controller.setReconstruction(result.parsed);
      } catch (err) {
        if (controller.epoch() !== epoch) return;
        if (err instanceof ReconstructionParseError && !isRetry) {
          LogBus.warn("deaf-session", "reconstruct parse error — retrying", {
            error: err.message,
          });
          await attempt(true);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        if (isQuotaExhausted(message)) {
          toast.error(
            "Session budget exhausted — refresh or open a new room",
          );
        } else {
          toast.error("LLM unavailable");
        }
        controller.setLLMError(message);
      }
    };

    void attempt(false);
    // Re-run when the controller transitions into stitching; epoch guard
    // protects against credential churn during the in-flight call.
  }, [snapshot.state]);

  // ----- speaking: ElevenLabs WSS + signchat-voice publish -------------------

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
    // Read store values via getState() so the effect doesn't have to depend
    // on subscribed credentials/prefs/room. The epoch guard rejects late
    // results if the underlying values churn mid-flight.
    const credSnap = useCredentialsStore.getState();
    const prefSnap = usePreferencesStore.getState();
    const roomSnap = useRoomStore.getState();
    const signedUrl = credSnap.elevenlabs?.signedUrl;
    if (!signedUrl) {
      toast.error("Voice unavailable — re-sign");
      controller.speakingError("ElevenLabs signed URL missing");
      return;
    }
    const r = roomRef.current;
    if (!r) {
      controller.speakingError("LiveKit room not available");
      return;
    }

    const modelId = credSnap.openrouter?.modelId ?? prefSnap.modelId;
    const fromInfo = participantInfoRef.current;
    const lastConfidence = approveContextRef.current?.confidence ?? "high";
    const lastUsedSigns = approveContextRef.current?.usedSigns ?? [];
    const turnStartedAtPerf =
      turnStartedAtPerfRef.current || performance.now();
    const roomIdSnap = roomSnap.roomId;
    const identitySnap = roomSnap.identity;

    let wss: Awaited<ReturnType<typeof openTurnWss>> | null = null;
    void (async () => {
      const mixer = ensureMixer(mixerRef);
      try {
        try {
          const micStream = await navigator.mediaDevices.getUserMedia({
            audio: MIC_CONSTRAINTS,
            video: false,
          });
          mixer.attachMic(micStream);
        } catch (err) {
          LogBus.warn(
            "deaf-session",
            "mic acquire failed; continuing without duck",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
        await ensureMixedPublished(r, mixer, mixedPubRef);

        const flags = useDebugFlagsStore.getState();
        if (flags.forceTTSError) {
          toast.error("Voice interrupted — re-sign");
          controller.speakingError("forced tts_unavailable");
          return;
        }

        wss = await openTurnWss(signedUrl);
        if (controller.epoch() !== epoch) return;

        await speak({
          wss,
          mixer,
          text: sentence,
          duckMic: true,
          onFirstAudible: (firstAudibleAt) => {
            if (controller.epoch() !== epoch) return;
            const latencyMs = Math.round(
              performance.now() - turnStartedAtPerf,
            );
            // Echo to the local transcript store so the Deaf signer's own
            // tile pins the caption; LiveKit data publish doesn't echo to
            // sender, so without this the signer would never see their
            // sentence pinned to their own video tile.
            const ts = Date.now();
            const playAtMs =
              ts +
              Math.max(0, firstAudibleAt - mixer.audioCtx.currentTime) * 1000;
            useTranscriptStore.getState().appendMessage({
              v: 1,
              kind: "caption",
              id: turnIdRef.current || `t_${ts}`,
              ts,
              playAtMs,
              from: fromInfo,
              sentence,
              confidence: lastConfidence,
              usedSigns: lastUsedSigns,
              modelId,
              latencyMs,
            });
            void broadcastCaption({
              room: r,
              audioCtx: mixer.audioCtx,
              firstAudibleAt,
              from: fromInfo,
              sentence,
              confidence: lastConfidence,
              usedSigns: lastUsedSigns,
              modelId,
              latencyMs,
              turnId: turnIdRef.current,
            });
          },
        });

        if (controller.epoch() !== epoch) return;
        const tid = turnIdRef.current;
        if (tid) mark("e2e.turn", tid, "end");
        controller.speakingDone();
      } catch (err) {
        if (controller.epoch() !== epoch) return;
        const message = err instanceof Error ? err.message : String(err);
        if (looksLikeUrlExpiry(message)) {
          // Re-mint proactively so the next turn has a fresh URL ready.
          if (roomIdSnap && identitySnap) {
            void mintElevenLabsSignedUrl({
              roomId: roomIdSnap,
              identity: identitySnap,
              role: "deaf",
            })
              .then((fresh) => {
                useCredentialsStore.getState().setElevenLabs({
                  signedUrl: fresh.signedUrl,
                  voiceId: fresh.voiceId,
                  modelId: fresh.modelId,
                  outputFormat: fresh.outputFormat,
                  expiresAt: fresh.expiresAt,
                });
              })
              .catch((mintErr) => {
                LogBus.warn("deaf-session", "post-expiry re-mint failed", {
                  error:
                    mintErr instanceof Error
                      ? mintErr.message
                      : String(mintErr),
                });
              });
          }
          toast.error("Voice unavailable — re-sign");
          controller.speakingError("Voice unavailable — re-sign");
        } else {
          toast.error("Voice interrupted — re-sign");
          controller.speakingError(message);
        }
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
  }, [snapshot.state]);

  // ----- proactive ElevenLabs URL re-mint (<30s remaining) -------------------

  useEffect(() => {
    const expiresAt = credentials.elevenlabs?.expiresAt;
    if (!expiresAt || !roomId || !identity) return;
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry)) return;

    const fireIn = Math.max(0, expiry - Date.now() - REMINT_THRESHOLD_MS);
    const timer = setTimeout(() => {
      void mintElevenLabsSignedUrl({ roomId, identity, role: "deaf" })
        .then((fresh) => {
          setElevenLabs({
            signedUrl: fresh.signedUrl,
            voiceId: fresh.voiceId,
            modelId: fresh.modelId,
            outputFormat: fresh.outputFormat,
            expiresAt: fresh.expiresAt,
          });
          LogBus.info("deaf-session", "elevenlabs url re-minted", {
            expiresAt: fresh.expiresAt,
          });
        })
        .catch((err) => {
          LogBus.warn("deaf-session", "proactive re-mint failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }, fireIn);
    return () => clearTimeout(timer);
  }, [credentials.elevenlabs?.expiresAt, roomId, identity, setElevenLabs]);

  // ----- LiveKit reconnect cancels in-flight capture -------------------------

  useEffect(() => {
    if (connectionState !== "reconnecting") return;
    if (snapshot.state === "capturing") {
      LogBus.info("deaf-session", "livekit reconnecting; cancelling capture");
      controllerRef.current?.cancel();
    }
  }, [connectionState, snapshot.state]);

  // ----- visibilitychange: resume audioCtx + warn about hidden speak ---------

  useEffect(() => {
    if (typeof document === "undefined") return;
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        if (controllerRef.current?.snapshot().state === "speaking") {
          wasSpeakingWhenHiddenRef.current = true;
        }
        return;
      }
      const m = mixerRef.current;
      if (m) void m.audioCtx.resume();
      if (wasSpeakingWhenHiddenRef.current) {
        wasSpeakingWhenHiddenRef.current = false;
        toast.info("voice paused while tab was hidden");
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // ----- approve handler stashes preview metadata for the broadcast ----------

  const handleApprove = (text: string) => {
    const c = controllerRef.current;
    if (!c) return;
    const preview = c.snapshot().preview;
    if (preview) {
      approveContextRef.current = {
        confidence: preview.confidence,
        usedSigns: preview.usedSigns,
      };
    }
    c.approve(text);
  };

  const handleResign = () => {
    controllerRef.current?.resign();
  };

  const handleDiscard = () => {
    controllerRef.current?.discard();
  };

  // ----- render --------------------------------------------------------------

  if (
    snapshot.state === "idle" ||
    snapshot.state === "stitching" ||
    snapshot.state === "speaking"
  ) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute inset-0">
      {snapshot.state === "capturing" ? (
        <div className="pointer-events-auto absolute inset-x-3 bottom-3 flex justify-center">
          <div className="rounded-sc-full bg-black/55 px-3 py-1.5 backdrop-blur">
            <TokenChipStrip tokens={snapshot.buffer.tokens} />
          </div>
        </div>
      ) : null}
      {snapshot.state === "preview" && snapshot.preview ? (
        <div className="pointer-events-auto absolute inset-x-3 bottom-3">
          <InlinePreview
            preview={snapshot.preview}
            onApprove={handleApprove}
            onResign={handleResign}
            onDiscard={handleDiscard}
          />
        </div>
      ) : null}
    </div>
  );
}

// ----- helpers ---------------------------------------------------------------

function ensureMixer(ref: { current: VoiceMixer | null }): VoiceMixer {
  if (!ref.current) {
    ref.current = createVoiceMixer();
  }
  return ref.current;
}

async function ensureMixedPublished(
  room: Room,
  mixer: VoiceMixer,
  pubRef: { current: LocalTrackPublication | null },
): Promise<void> {
  if (pubRef.current) return;
  const lp = room.localParticipant;
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
  LogBus.info("deaf-session", "published signchat-voice", {
    sid: pubRef.current.trackSid,
  });
}

function isQuotaExhausted(message: string): boolean {
  return /\b429\b/.test(message) || /quota_exhausted/i.test(message);
}

function looksLikeUrlExpiry(message: string): boolean {
  return /\b(401|403)\b/.test(message) ||
    /\b(expired|unauthorized|forbidden|invalid[_ ]token)\b/i.test(message);
}
