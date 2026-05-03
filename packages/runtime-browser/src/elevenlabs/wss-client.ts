import { log } from "../logger";
import { mark, newTurnId } from "../diagnostics/mark";

/**
 * Thin, typed wrapper around the browser's `WebSocket` for the ElevenLabs
 * streaming TTS endpoint. Per ARCHITECTURE.md §11.2 the wire format is:
 *
 *   send: { text, voice_settings?, generation_config?, flush? }
 *   recv: { audio?: base64, alignment?: {...}, isFinal?: boolean } interleaved
 *
 * Frames are tagged into a discriminated union so callers do not pattern-
 * match on undefined keys. The wrapper is per-WSS, not per-turn — the
 * pane (Phase 4) and Phase 6 reuse one connection across multiple speak
 * turns when the signed URL is still fresh.
 */

export interface ElevenLabsVoiceSettings {
  stability?: number;
  similarity_boost?: number;
}

export interface ElevenLabsGenerationConfig {
  /** Per §11.2 default: [120, 160, 250, 290] for low-latency chunking. */
  chunk_length_schedule?: number[];
}

export interface ElevenLabsTTSInput {
  text: string;
  voice_settings?: ElevenLabsVoiceSettings;
  generation_config?: ElevenLabsGenerationConfig;
  /**
   * §11.2 of ARCHITECTURE.md — sent at end of sentence to flush buffered
   * audio. Some endpoint variants accept this as a one-shot replacement
   * for the init + content + EOS pattern; the workbench sends the explicit
   * three-frame pattern in lib/elevenlabs/streaming.ts since that's what
   * the live ElevenLabs server requires today.
   */
  flush?: boolean;
  /**
   * ElevenLabs stream-input flag that asks the server to start generating
   * audio for this content frame immediately rather than waiting for more
   * text. Required by the live server alongside the init+EOS pattern.
   */
  try_trigger_generation?: boolean;
}

export interface AlignmentFrame {
  chars: string[];
  charStartTimesMs: number[];
  charDurationsMs: number[];
}

export type ElevenLabsFrame =
  | {
      kind: "audio";
      audioBase64: string;
      alignment?: AlignmentFrame;
      isFinal: boolean;
    }
  | {
      kind: "alignment";
      alignment: AlignmentFrame;
      isFinal: boolean;
    }
  | {
      kind: "final";
    }
  | {
      kind: "error";
      message: string;
    };

export type FrameSubscriber = (frame: ElevenLabsFrame) => void;

export interface ElevenLabsWss {
  send(msg: ElevenLabsTTSInput): void;
  /** Returns an unsubscribe. */
  onMessage(cb: FrameSubscriber): () => void;
  close(): void;
  readyState: number;
  /** Resolved with the full URL host+path; never includes the token query string. */
  hostInfo: string;
}

const OPEN_TIMEOUT_MS = 10_000;

export async function connectElevenLabsWss(
  signedUrl: string,
): Promise<ElevenLabsWss> {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  const turnId = newTurnId();
  mark("tts.wss.open", turnId, "start");
  const ws = new WebSocket(signedUrl);
  ws.binaryType = "arraybuffer";

  const subscribers = new Set<FrameSubscriber>();
  let closed = false;

  ws.addEventListener("message", (event) => {
    const frame = parseFrame(event.data);
    if (!frame) return;
    for (const cb of subscribers) {
      try {
        cb(frame);
      } catch (err) {
        log.warn("elevenlabs", "frame subscriber threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
  ws.addEventListener("error", () => {
    log.warn("elevenlabs", "wss error event");
    for (const cb of subscribers) {
      try {
        cb({ kind: "error", message: "websocket error" });
      } catch {
        // ignore
      }
    }
  });
  ws.addEventListener("close", (event) => {
    closed = true;
    log.debug("elevenlabs", "wss closed", {
      code: event.code,
      reason: event.reason || undefined,
    });
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`ElevenLabs WSS open timeout after ${OPEN_TIMEOUT_MS}ms`));
    }, OPEN_TIMEOUT_MS);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        mark("tts.wss.open", turnId, "end");
        // Strip query string before logging so the single_use_token never
        // hits the log surface.
        const safeUrl = signedUrl.split("?")[0] ?? signedUrl;
        log.info("elevenlabs", "wss connected", { url: safeUrl });
        resolve();
      },
      { once: true },
    );
    ws.addEventListener(
      "error",
      (event) => {
        clearTimeout(timer);
        mark("tts.wss.open", turnId, "end");
        reject(
          new Error(
            `ElevenLabs WSS connect failed: ${(event as Event).type}`,
          ),
        );
      },
      { once: true },
    );
  });

  const safeHost = (() => {
    try {
      const u = new URL(signedUrl);
      return `${u.host}${u.pathname}`;
    } catch {
      return "(unknown)";
    }
  })();

  return {
    hostInfo: safeHost,
    get readyState() {
      return ws.readyState;
    },
    send(msg: ElevenLabsTTSInput): void {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        throw new Error("ElevenLabs WSS is not open");
      }
      ws.send(JSON.stringify(msg));
    },
    onMessage(cb: FrameSubscriber): () => void {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
    close(): void {
      if (closed) return;
      try {
        ws.close(1000, "client done");
      } catch {
        // ignore
      }
    },
  };
}

function parseFrame(raw: unknown): ElevenLabsFrame | null {
  if (typeof raw !== "string") {
    log.debug("elevenlabs", "non-string ws frame", {
      type: typeof raw,
    });
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    log.warn("elevenlabs", "non-JSON ws frame", {
      preview: raw.slice(0, 80),
    });
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  const isFinal = o.isFinal === true;
  if (typeof o.audio === "string" && o.audio.length > 0) {
    const alignment = parseAlignment(o.alignment);
    return {
      kind: "audio",
      audioBase64: o.audio,
      ...(alignment ? { alignment } : {}),
      isFinal,
    };
  }
  // ElevenLabs sometimes sends final-only frames with audio:null and
  // isFinal:true to signal end-of-turn. Treat as `final`.
  if (o.audio === null && isFinal) {
    return { kind: "final" };
  }
  if (typeof o.message === "string" && o.error === true) {
    return { kind: "error", message: o.message };
  }
  const alignment = parseAlignment(o.alignment);
  if (alignment) {
    return { kind: "alignment", alignment, isFinal };
  }
  if (isFinal) return { kind: "final" };
  return null;
}

function parseAlignment(value: unknown): AlignmentFrame | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (
    Array.isArray(o.chars) &&
    Array.isArray(o.charStartTimesMs) &&
    Array.isArray(o.charDurationsMs)
  ) {
    return {
      chars: o.chars.filter((c): c is string => typeof c === "string"),
      charStartTimesMs: o.charStartTimesMs.filter(
        (n): n is number => typeof n === "number",
      ),
      charDurationsMs: o.charDurationsMs.filter(
        (n): n is number => typeof n === "number",
      ),
    };
  }
  return null;
}
