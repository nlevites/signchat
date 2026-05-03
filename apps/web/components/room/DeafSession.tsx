"use client";

import { useEffect, useRef } from "react";
import {
  AudioPresets,
  type LocalAudioTrack,
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
  buildReconstructionRequest,
  ReconstructionParseError,
  type ReconstructionModelId,
} from "@signchat/prompts";
import {
  acquireController,
  useModeSnapshot,
} from "@signchat/runtime-browser/mode-controller/controller-store";
import type { ModeController } from "@signchat/runtime-browser/mode-controller/mode-controller";
import type { ClassifierResult } from "@signchat/runtime-browser/sign-pipeline/classifier";
import type { VisionFrame } from "@signchat/runtime-browser/sign-pipeline/mediapipe-runner";
import { MediaPipeOnnxClassifier } from "@signchat/runtime-browser/sign-pipeline/mediapipe-onnx-classifier";
import { reconstruct } from "@signchat/runtime-browser/openrouter/client";
import {
  createVoiceMixer,
  type VoiceMixer,
} from "@signchat/runtime-browser/audio/voice-mixer";
import {
  openTurnWss,
  speak,
} from "@signchat/runtime-browser/elevenlabs/streaming";
import {
  createSttStream,
  type SttStream,
  type SttPartialEvent,
  type SttFinalEvent,
} from "@signchat/runtime-browser/elevenlabs/stt-streaming";
import "@/lib/diagnostics/runtime-bridge";
import { broadcastCaption } from "@/lib/livekit/caption-broadcast";
import { mintElevenLabsSignedUrl } from "@/lib/livekit/mint-elevenlabs";
import { mintElevenLabsSttSignedUrl } from "@/lib/livekit/mint-elevenlabs-stt";
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

/**
 * Sign labels that the classifier must never surface in its top-K result.
 * Their post-softmax probabilities are zeroed before ranking so they cannot
 * win, regardless of model confidence. Names must match the JSON keys in
 * apps/web/public/models/asl-signs/sign_to_prediction_index_map.json
 * exactly (case-sensitive). Add new entries here only after confirming the
 * label is present in the vocabulary.
 */
const BLOCKED_SIGN_LABELS = new Set<string>(["giraffe", "drop"]);

export interface DeafSessionProps {
  room: Room | null;
  localVideoTrack: LocalVideoTrack | null;
  remoteAudioTrack: RemoteAudioTrack | null;
  participantInfo: ParticipantInfo;
  recentDialogContext: () => string[];
  /** Publish a RoomDataMessage on the LiveKit data channel. */
  publish: (msg: RoomDataMessage) => Promise<void>;
}

export function DeafSession({
  room,
  localVideoTrack,
  remoteAudioTrack,
  participantInfo,
  recentDialogContext,
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
  const sttStreamRef = useRef<SttStream | null>(null);
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
  const transcriptCtxRef = useRef(recentDialogContext);
  transcriptCtxRef.current = recentDialogContext;
  // Latch publish so the stt-stream effect doesn't tear down when the
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
      autoStartThreshold: prefs.thresholds.autoStartThreshold ?? 0.25,
      autoStopThreshold: prefs.thresholds.autoStopThreshold ?? 0.03,
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

    /* Debug-signals broadcast — re-publish the latest frame + result as a
     * lossy data-channel message so the hearing peer can render the same
     * mediapipe overlay in their debug view. throttle to ~6 fps so we
     * don't saturate the data channel; mediapipe runs at 30 fps and we
     * only need a smooth-enough overlay. */
    let lastPublishMs = 0;
    let pendingFrameRef: VisionFrame | null = null;
    let pendingResultRef: ClassifierResult | null = null;
    const PUBLISH_INTERVAL_MS = 150;
    const flushDebugPublish = () => {
      const now = Date.now();
      if (now - lastPublishMs < PUBLISH_INTERVAL_MS) return;
      lastPublishMs = now;
      const msg: RoomDataMessage = {
        v: 1,
        kind: "debug_signals",
        id: `dbg-${now}`,
        ts: now,
        from: participantInfo,
        frame: pendingFrameRef,
        result: pendingResultRef,
      };
      void publishRef.current(msg).catch(() => {
        // unreliable channel — silent drops are fine
      });
    };

    const cls = new MediaPipeOnnxClassifier({
      config: { inferenceIntervalMs: prefs.thresholds.intervalMs },
      stream,
      blockedLabels: BLOCKED_SIGN_LABELS,
      onFrame: (frame) => {
        useDebugSignalsStore.getState().setLatestFrame(frame);
        pendingFrameRef = frame;
        flushDebugPublish();
      },
    });
    const offResult = cls.onResult((result) => {
      controllerRef.current?.ingest(result);
      useDebugSignalsStore.getState().setLatestResult(result);
      pendingResultRef = result;
      flushDebugPublish();
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

  // ----- elevenlabs STT streaming on the Hearing user's audio track ----------

  useEffect(() => {
    LogBus.info("stt", "effect entered", {
      hasTrack: !!remoteAudioTrack,
      remoteRole: remoteParticipant?.role ?? null,
      remoteIdentity: remoteParticipant?.identity ?? null,
    });
    if (!remoteAudioTrack) return;
    if (remoteParticipant?.role !== "hearing") return;
    const speaker = remoteParticipant;
    const roomSnap = useRoomStore.getState();
    const roomIdSnap = roomSnap.roomId;
    const identitySnap = roomSnap.identity;
    if (!roomIdSnap || !identitySnap) {
      LogBus.warn("deaf-session", "stt skipped: missing room context");
      return;
    }

    let cancelled = false;
    let started: SttStream | null = null;
    void (async () => {
      let signedUrl: string;
      try {
        const fresh = await mintElevenLabsSttSignedUrl({
          roomId: roomIdSnap,
          identity: identitySnap,
          role: "deaf",
        });
        signedUrl = fresh.signedUrl;
        LogBus.info("deaf-session", "stt signed url minted", {
          expiresAt: fresh.expiresAt,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        LogBus.error("deaf-session", "stt url mint failed", { message });
        toast.error("Captions unavailable");
        return;
      }
      if (cancelled) return;
      const audioStream = new MediaStream([remoteAudioTrack.mediaStreamTrack]);
      const stream = createSttStream({
        signedUrl,
        audioStream,
        speaker,
        onPartial: (event: SttPartialEvent) => {
          useTranscriptStore.getState().upsertPartial(event.utteranceId, {
            from: event.speaker,
            text: event.text,
            ts: event.ts,
          });
          void publishRef
            .current({
              v: 1,
              kind: "transcript_partial",
              id: event.utteranceId,
              ts: event.ts,
              from: event.speaker,
              text: event.text,
            })
            .catch((err) => {
              LogBus.warn("deaf-session", "transcript_partial publish failed", {
                error: err instanceof Error ? err.message : String(err),
                id: event.utteranceId,
              });
            });
        },
        onFinal: (event: SttFinalEvent) => {
          const msg: RoomDataMessage = {
            v: 1,
            kind: "transcript_final",
            id: event.utteranceId,
            ts: event.ts,
            from: event.speaker,
            text: event.text,
          };
          const store = useTranscriptStore.getState();
          store.appendMessage(msg);
          store.finalizePartial(event.utteranceId);
          void publishRef.current(msg).catch((err) => {
            LogBus.warn("deaf-session", "transcript_final publish failed", {
              error: err instanceof Error ? err.message : String(err),
              id: event.utteranceId,
            });
          });
        },
        onError: (event) => {
          if (event.fatal) {
            toast.error("Captions unavailable");
          }
        },
      });
      started = stream;
      sttStreamRef.current = stream;
      try {
        await stream.start();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        LogBus.error("deaf-session", "stt stream start failed", { message });
      }
    })();

    return () => {
      cancelled = true;
      const stream = started;
      if (stream && sttStreamRef.current === stream) {
        sttStreamRef.current = null;
      }
      if (stream) void stream.stop();
    };
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
    // Multi-line dialog block — newline-delimited so each turn renders on
    // its own line in the user prompt template.
    const recentDialog = transcriptCtxRef.current().join("\n").trim();

    // Mirror what reconstruct() builds so the debug pane can show the exact
    // prompt being sent before the call lands. Re-using the shared builder
    // keeps this in lockstep with the wire payload.
    const previewBody = buildReconstructionRequest({
      recentDialog,
      topK,
      modelId,
    });
    const [previewSystem, previewUser] = previewBody.messages;
    const sentAt = Date.now();
    useDebugSignalsStore.getState().setReconstructPromptPending({
      modelId,
      systemPrompt: previewSystem?.content ?? "",
      userPrompt: previewUser?.content ?? "",
      signs: tokens.map((t) => t.label),
      sentAt,
    });

    const attempt = async (isRetry: boolean): Promise<void> => {
      try {
        const result = await reconstruct({
          apiKey,
          modelId,
          recentDialog,
          topK,
        });
        if (controller.epoch() !== epoch) {
          LogBus.debug("deaf-session", "stale reconstruct dropped");
          return;
        }
        useDebugSignalsStore.getState().patchReconstructPrompt({
          status: "ok",
          latencyMs: result.latencyMs,
          parsed: result.parsed,
          raw: result.raw,
          ...(result.usage?.inputTokens !== undefined
            ? { inputTokens: result.usage.inputTokens }
            : {}),
          ...(result.usage?.outputTokens !== undefined
            ? { outputTokens: result.usage.outputTokens }
            : {}),
          ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
        });
        // Stash broadcast metadata before setReconstruction. In Auto mode
        // the controller transitions straight to speaking (no handleApprove
        // runs to populate this), so the speaking effect would otherwise
        // fall back to defaults for confidence/usedSigns.
        approveContextRef.current = {
          confidence: result.parsed.confidence,
          usedSigns: result.parsed.usedSigns,
        };
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
        useDebugSignalsStore.getState().patchReconstructPrompt({
          status: "error",
          latencyMs: Date.now() - sentAt,
          errorMessage: message,
        });
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

      // ElevenLabs signed URLs embed a single_use_token consumed per
      // WS connection. The cached URL is the next-to-use one; if it's
      // missing (post-turn pre-mint hadn't completed yet) we mint
      // synchronously here. This adds ~250ms p50 only on cache miss.
      let signedUrl: string | null =
        useCredentialsStore.getState().elevenlabs?.signedUrl ?? null;
      if (!signedUrl) {
        if (!roomIdSnap || !identitySnap) {
          controller.speakingError(
            "Cannot mint ElevenLabs URL without room context",
          );
          return;
        }
        const voiceId =
          usePreferencesStore.getState().elevenlabsVoiceId ?? undefined;
        try {
          const fresh = await mintElevenLabsSignedUrl({
            roomId: roomIdSnap,
            identity: identitySnap,
            role: "deaf",
            ...(voiceId ? { voiceId } : {}),
          });
          useCredentialsStore.getState().setElevenLabs({
            signedUrl: fresh.signedUrl,
            voiceId: fresh.voiceId,
            modelId: fresh.modelId,
            outputFormat: fresh.outputFormat,
            expiresAt: fresh.expiresAt,
          });
          signedUrl = fresh.signedUrl;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          toast.error("Voice unavailable — re-sign");
          controller.speakingError(`ElevenLabs URL mint failed: ${message}`);
          return;
        }
      }

      try {
        // ensureMixedPublished both swaps the raw mic publication for the
        // mixed signchat-voice track and attaches the existing LiveKit mic
        // capture into the mixer (no second getUserMedia call).
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
            const voiceId =
              usePreferencesStore.getState().elevenlabsVoiceId ?? undefined;
            void mintElevenLabsSignedUrl({
              roomId: roomIdSnap,
              identity: identitySnap,
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
          // Invalidate the cached URL (the single_use_token has been
          // consumed by the WSS we just opened, regardless of whether
          // speak() succeeded) and kick off a background pre-mint for
          // the next turn. The mint runs while the user is signing
          // their next sentence, so the next speaking effect lands on
          // a fresh cache hit with zero added latency.
          useCredentialsStore.getState().setElevenLabs(null);
          if (roomIdSnap && identitySnap) {
            const voiceId =
              usePreferencesStore.getState().elevenlabsVoiceId ?? undefined;
            void mintElevenLabsSignedUrl({
              roomId: roomIdSnap,
              identity: identitySnap,
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
                LogBus.debug(
                  "deaf-session",
                  "next-turn elevenlabs url pre-minted",
                  { expiresAt: fresh.expiresAt },
                );
              })
              .catch((err) => {
                LogBus.warn("deaf-session", "next-turn pre-mint failed", {
                  error: err instanceof Error ? err.message : String(err),
                });
              });
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
      const voiceId =
        usePreferencesStore.getState().elevenlabsVoiceId ?? undefined;
      void mintElevenLabsSignedUrl({
        roomId,
        identity,
        role: "deaf",
        ...(voiceId ? { voiceId } : {}),
      })
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
    // Resume the AudioContext under the user-gesture window so the mixer's
    // MediaStreamDestination starts producing real samples before the first
    // PCM chunk arrives over the WSS. The context is created suspended per
    // browser autoplay policy; speak() also calls resume() but by then we
    // may have lost user activation through the await chain.
    void ensureMixer(mixerRef).resume().catch(() => {
      // Already running, or interrupted — speak()'s own resume() will retry.
    });
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
  // §5.2 / §8.2: only one outgoing audio track. Reuse the LiveKit-managed
  // mic capture for the mixer rather than acquiring a parallel mic via
  // getUserMedia — a second capture of the same device shares no AEC
  // reference with the first, captures the audio output (Hearing voice
  // from speakers), and produces a feedback loop into signchat-voice.
  // We unpublish the raw mic with stopOnUnpublish=false so the underlying
  // MediaStreamTrack survives and can drive the mixer.
  let micMediaTrack: MediaStreamTrack | null = null;
  for (const pub of lp.audioTrackPublications.values()) {
    if (pub.source === Track.Source.Microphone && pub.track) {
      const liveTrack = pub.track as LocalAudioTrack;
      if (!micMediaTrack) micMediaTrack = liveTrack.mediaStreamTrack;
      try {
        await lp.unpublishTrack(liveTrack, false);
      } catch {
        // ignore
      }
    }
  }
  if (micMediaTrack) {
    mixer.attachMic(new MediaStream([micMediaTrack]));
    LogBus.debug("deaf-session", "mixer reusing live mic", {
      trackId: micMediaTrack.id,
    });
  } else {
    LogBus.warn(
      "deaf-session",
      "no local mic available for mixer (joined with mic off?)",
    );
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
