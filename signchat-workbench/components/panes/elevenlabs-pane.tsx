"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AudioPresets,
  ConnectionState,
  type LocalTrackPublication,
  Track,
} from "livekit-client";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { useLatencyStats } from "@/lib/diagnostics/latency-markers";
import { useCredentials, CredentialStore } from "@/lib/credentials/store";
import { mintElevenLabsSignedUrl } from "@/lib/credentials/mint-clients";
import { useRoomState } from "@/lib/livekit/room-store";
import { sanitizeForTts } from "@/lib/elevenlabs/sanitize";
import {
  openTurnWss,
  speak,
  type SpeakResult,
} from "@/lib/elevenlabs/streaming";
import {
  createVoiceMixer,
  type VoiceMixer,
} from "@/lib/audio/voice-mixer";

/**
 * Phase 4 — ElevenLabs streaming TTS + signchat-voice mixer.
 *
 * Three speak modes per the plan:
 *   1. Speak (local)       speakers only, no mic, monitor on
 *   2. Speak + duck mic    mic + TTS in mixer, monitor on, duck around turn
 *   3. Speak + publish     same mixer, output track published as
 *                          signchat-voice with §8.2 flags. Existing mic
 *                          publication is unpublished first per §5.2.
 *
 * Mode 3 needs a connected LiveKit room (Phase 2). The pane reads the room
 * directly from RoomStore.
 */

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const MIXED_TRACK_NAME = "signchat-voice";

type Mode = "local" | "duck" | "publish";

interface HistoryEntry {
  id: number;
  ts: number;
  mode: Mode;
  text: string;
  result: SpeakResult;
}

export function ElevenLabsPane() {
  const credentials = useCredentials();
  const roomState = useRoomState();
  const wssOpenLatency = useLatencyStats("tts.wss.open");
  const firstByteLatency = useLatencyStats("tts.firstByte");
  const firstAudibleLatency = useLatencyStats("tts.firstAudible");
  const turnEndLatency = useLatencyStats("tts.turnEnd");

  const [text, setText] = useState<string>("Pizza sounds great!");
  const [mode, setMode] = useState<Mode>("local");
  const [busy, setBusy] = useState<boolean>(false);
  const [reminting, setReminting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<SpeakResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [nowMs, setNowMs] = useState<number>(() =>
    typeof window === "undefined" ? 0 : Date.now(),
  );

  const mixerRef = useRef<VoiceMixer | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mixedPubRef = useRef<LocalTrackPublication | null>(null);
  const historyIdRef = useRef<number>(1);

  useEffect(() => {
    LogBus.debug("elevenlabs", "elevenlabs pane mounted");
  }, []);

  // Tick once a second so the expired chip + canSpeak gate update without
  // calling Date.now() during render (React compiler enforces purity).
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (mixedPubRef.current) {
        const room = roomState.room;
        const track = mixedPubRef.current.track;
        if (room && track) {
          try {
            void room.localParticipant.unpublishTrack(track);
          } catch {
            // ignore
          }
        }
        mixedPubRef.current = null;
      }
      if (micStreamRef.current) {
        for (const t of micStreamRef.current.getTracks()) {
          try {
            t.stop();
          } catch {
            // ignore
          }
        }
        micStreamRef.current = null;
      }
      if (mixerRef.current) {
        mixerRef.current.dispose();
        mixerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sanitized = useMemo(() => sanitizeForTts(text), [text]);
  const sanitizeChanged =
    sanitized !== text.trim().replace(/\s+/g, " ") ||
    sanitized.length !== text.trim().length;

  const isHearingRole = credentials.context?.role === "hearing";
  const hasSignedUrl = Boolean(credentials.elevenlabs?.signedUrl);
  const expiresAt = credentials.elevenlabs?.expiresAt
    ? new Date(credentials.elevenlabs.expiresAt).getTime()
    : null;
  const expired = expiresAt !== null && nowMs > 0 && expiresAt < nowMs;
  const isConnected = roomState.state === ConnectionState.Connected;

  const canSpeak =
    hasSignedUrl &&
    !expired &&
    !isHearingRole &&
    !busy &&
    sanitized.length > 0 &&
    (mode !== "publish" || isConnected);

  const ensureMixer = (): VoiceMixer => {
    if (!mixerRef.current) {
      mixerRef.current = createVoiceMixer();
    }
    return mixerRef.current;
  };

  const ensureMic = async (): Promise<MediaStream> => {
    if (micStreamRef.current && micStreamRef.current.active) {
      return micStreamRef.current;
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: MIC_CONSTRAINTS,
      video: false,
    });
    micStreamRef.current = stream;
    return stream;
  };

  const ensureMixedTrackPublished = async (): Promise<void> => {
    const room = roomState.room;
    if (!room) throw new Error("LiveKit room is not connected");
    if (mixedPubRef.current) return;
    const lp = room.localParticipant;
    // §5.2: only one outgoing audio track. Unpublish any existing mic
    // before adding the mixed track.
    for (const pub of lp.audioTrackPublications.values()) {
      if (pub.source === Track.Source.Microphone && pub.track) {
        try {
          await lp.unpublishTrack(pub.track, true);
          LogBus.info("elevenlabs", "unpublished existing mic", {
            sid: pub.trackSid,
          });
        } catch (err) {
          LogBus.warn("elevenlabs", "failed to unpublish existing mic", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    const mixer = ensureMixer();
    const pub = await lp.publishTrack(mixer.outputTrack, {
      source: Track.Source.Microphone,
      name: MIXED_TRACK_NAME,
      dtx: false,
      red: true,
      audioPreset: AudioPresets.speech,
    });
    mixedPubRef.current = pub;
    LogBus.info("elevenlabs", "published signchat-voice", {
      sid: pub.trackSid,
    });
  };

  const unpublishMixedTrack = async (): Promise<void> => {
    if (!mixedPubRef.current) return;
    const room = roomState.room;
    const track = mixedPubRef.current.track;
    if (room && track) {
      try {
        await room.localParticipant.unpublishTrack(track, false);
        LogBus.info("elevenlabs", "unpublished signchat-voice");
      } catch (err) {
        LogBus.warn("elevenlabs", "unpublish signchat-voice failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    mixedPubRef.current = null;
  };

  const handleModeChange = async (next: Mode): Promise<void> => {
    if (next === mode) return;
    setError(null);
    setMode(next);
    if (mode === "publish" && next !== "publish") {
      await unpublishMixedTrack();
    }
  };

  const onSpeak = async (): Promise<void> => {
    if (!credentials.elevenlabs?.signedUrl) return;
    setBusy(true);
    setError(null);
    let wssOpened = false;
    let wss = null as Awaited<ReturnType<typeof openTurnWss>> | null;
    try {
      const mixer = ensureMixer();
      // Always run the local monitor on local + duck so the operator hears
      // the result. For publish, default to monitor-off to avoid speaker
      // echo into the unpublished mic capture (we still publish via the
      // mixer so the remote subscriber hears the TTS).
      mixer.setMonitorEnabled(mode !== "publish");

      if (mode === "duck" || mode === "publish") {
        const stream = await ensureMic();
        mixer.attachMic(stream);
      } else {
        mixer.detachMic();
      }

      if (mode === "publish") {
        await ensureMixedTrackPublished();
      }

      wss = await openTurnWss(credentials.elevenlabs.signedUrl);
      wssOpened = true;

      const result = await speak({
        wss,
        mixer,
        text,
        duckMic: mode === "duck" || mode === "publish",
      });

      setLatest(result);
      setHistory((prev) => {
        const entry: HistoryEntry = {
          id: historyIdRef.current++,
          ts: Date.now(),
          mode,
          text: result.sentText,
          result,
        };
        return [entry, ...prev].slice(0, 10);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      LogBus.error("elevenlabs", "speak failed", { error: message });
      setError(message);
    } finally {
      if (wssOpened && wss) {
        try {
          wss.close();
        } catch {
          // ignore
        }
      }
      setBusy(false);
    }
  };

  const onRemint = async (): Promise<void> => {
    if (!credentials.context) return;
    setReminting(true);
    setError(null);
    try {
      const result = await mintElevenLabsSignedUrl({
        roomId: credentials.context.roomId,
        identity: credentials.context.identity,
      });
      CredentialStore.setElevenLabs(result);
      LogBus.info("elevenlabs", "signed URL re-minted", {
        expiresAt: result.expiresAt,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReminting(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex flex-wrap items-baseline gap-3">
          <h2 className="text-xl font-semibold text-slate-100">
            ElevenLabs streaming TTS
          </h2>
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
            Phase 4 — live
          </span>
          {hasSignedUrl ? (
            expired ? (
              <span className="rounded-full border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-rose-200">
                signed url expired
              </span>
            ) : (
              <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-200">
                signed url ready
              </span>
            )
          ) : (
            <span className="rounded-full border border-slate-600 bg-slate-700/30 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">
              no signed url
            </span>
          )}
          <span className="ml-auto flex items-center gap-3 text-[11px] text-slate-500">
            {firstAudibleLatency ? (
              <span>
                first-audible p50 {Math.round(firstAudibleLatency.p50)}ms / p95{" "}
                {Math.round(firstAudibleLatency.p95)}ms
              </span>
            ) : null}
            {wssOpenLatency ? (
              <span>
                wss-open p50 {Math.round(wssOpenLatency.p50)}ms
              </span>
            ) : null}
          </span>
        </div>
        {isHearingRole ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            ElevenLabs is deaf-only (ARCHITECTURE.md §10.3). Switch role to
            <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5">
              deaf
            </code>{" "}
            in the Lobby and re-mint to use this pane.
          </p>
        ) : !hasSignedUrl ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            No ElevenLabs signed URL in the credentials store. Mint one in the
            Lobby first.
          </p>
        ) : (
          <p className="text-sm text-slate-400">
            Browser opens{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              wss://api.elevenlabs.io/v1/text-to-speech/.../stream-input
            </code>
            ; PCM frames decode at 24 kHz and feed the §8.1 mixer. Vercel is
            not on this hop.
          </p>
        )}
        {credentials.elevenlabs ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>
              voice <code className="text-slate-200">{credentials.elevenlabs.voiceId}</code>
            </span>
            <span>
              model{" "}
              <code className="text-slate-200">{credentials.elevenlabs.modelId}</code>
            </span>
            <span>
              format{" "}
              <code className="text-slate-200">
                {credentials.elevenlabs.outputFormat}
              </code>
            </span>
            {credentials.elevenlabs.expiresAt ? (
              <span>
                expires{" "}
                <span className="text-slate-200">
                  {new Date(credentials.elevenlabs.expiresAt).toLocaleTimeString()}
                </span>
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => void onRemint()}
              disabled={reminting || !credentials.context || isHearingRole}
              className="rounded-md border border-slate-600 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {reminting ? "re-minting…" : "re-mint"}
            </button>
          </div>
        ) : null}
      </header>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-400"
              htmlFor="el-text"
            >
              sentence
            </label>
            <textarea
              id="el-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <p className="text-[11px] text-slate-500">
              {sanitizeChanged ? (
                <>
                  sanitized:{" "}
                  <code className="rounded bg-slate-800 px-1 py-0.5 text-slate-300">
                    {sanitized || "(empty)"}
                  </code>
                </>
              ) : (
                <>strips parens / brackets / asterisks / emoji per §5.9</>
              )}
            </p>
          </div>

          <fieldset className="space-y-1.5">
            <legend className="block text-xs font-medium text-slate-400">
              speak mode
            </legend>
            <ModeRadio
              checked={mode === "local"}
              onChange={() => void handleModeChange("local")}
              label="Speak (local)"
              hint="TTS through speakers only. Fastest visual confirmation."
            />
            <ModeRadio
              checked={mode === "duck"}
              onChange={() => void handleModeChange("duck")}
              label="Speak + duck mic"
              hint="Mic + TTS through the §8.1 mixer; mic ducks to 0.3 around the turn."
            />
            <ModeRadio
              checked={mode === "publish"}
              onChange={() => void handleModeChange("publish")}
              label="Speak + publish to signchat-voice"
              hint={
                isConnected
                  ? "Unpublishes the existing mic and publishes the mixed track per §8.2 (dtx:false / red:true / preset:speech)."
                  : "Connect a LiveKit room first via the LiveKit pane."
              }
              disabled={!isConnected}
            />
          </fieldset>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onSpeak()}
              disabled={!canSpeak}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? "Speaking…" : "Speak"}
            </button>
            {error ? (
              <span className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
                {error}
              </span>
            ) : null}
          </div>
        </div>
      </div>

      {latest ? (
        <ResultCard
          result={latest}
          firstByte={firstByteLatency?.last}
          firstAudible={firstAudibleLatency?.last}
          turnEnd={turnEndLatency?.last}
        />
      ) : null}

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            History{" "}
            <span className="ml-1 text-[11px] font-normal text-slate-500">
              {history.length}/10
            </span>
          </h3>
          {history.length > 0 ? (
            <button
              type="button"
              onClick={() => setHistory([])}
              className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Clear
            </button>
          ) : null}
        </div>
        {history.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
            No turns yet. Pick a mode and click Speak.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1.5 text-xs"
              >
                <span className="w-16 shrink-0 truncate font-mono text-slate-400">
                  {entry.mode}
                </span>
                <span className="grow truncate text-slate-100">
                  {entry.text}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                  fb {Math.round(entry.result.firstByteMs)}ms · turn{" "}
                  {Math.round(entry.result.turnEndMs)}ms ·{" "}
                  {entry.result.chunkCount} chunks
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ModeRadio({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-md border px-2 py-1.5 ${
        checked
          ? "border-sky-500/40 bg-sky-500/10"
          : "border-slate-700 bg-slate-900"
      } ${disabled ? "opacity-50" : "cursor-pointer hover:border-slate-600"}`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1 h-3.5 w-3.5"
      />
      <div className="space-y-0.5">
        <div className="text-sm text-slate-100">{label}</div>
        <div className="text-[11px] text-slate-500">{hint}</div>
      </div>
    </label>
  );
}

function ResultCard({
  result,
  firstByte,
  firstAudible,
  turnEnd,
}: {
  result: SpeakResult;
  firstByte: number | undefined;
  firstAudible: number | undefined;
  turnEnd: number | undefined;
}) {
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-100">Last turn</h3>
        <span className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-fuchsia-200">
          {result.chunkCount} chunks
        </span>
      </div>
      <p className="mb-3 font-mono text-sm text-slate-200">
        “{result.sentText}”
      </p>
      <div className="grid gap-2 text-[11px] text-slate-400 sm:grid-cols-3">
        <Telemetry
          label="first-byte"
          value={firstByte !== undefined ? `${Math.round(firstByte)}ms` : `${Math.round(result.firstByteMs)}ms`}
          hint="text sent → first audio frame"
        />
        <Telemetry
          label="first-audible"
          value={
            firstAudible !== undefined
              ? `${Math.round(firstAudible)}ms`
              : "—"
          }
          hint="text sent → audioCtx-aligned playAtMs"
        />
        <Telemetry
          label="turn-end"
          value={
            turnEnd !== undefined
              ? `${Math.round(turnEnd)}ms`
              : `${Math.round(result.turnEndMs)}ms`
          }
          hint="text sent → last sample onended"
        />
        <Telemetry
          label="bytes"
          value={`${result.bytesReceived.toLocaleString()}`}
          hint="raw PCM bytes received"
        />
        <Telemetry
          label="alignment chars"
          value={`${result.alignmentChars}`}
          hint="diagnostic only — caption uses first-audible"
        />
        <Telemetry
          label="firstAudibleAt"
          value={`${result.firstAudibleAt.toFixed(3)}`}
          hint="audioCtx absolute time (s)"
        />
      </div>
    </div>
  );
}

function Telemetry({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border border-slate-800 bg-slate-900/40 p-2">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums text-slate-100">
        {value}
      </div>
      <div className="text-[10px] text-slate-500">{hint}</div>
    </div>
  );
}
