import { useEffect, useState } from "react";
import { log } from "@signchat/runtime-browser/logger";
import {
  mintElevenLabsSignedUrl,
  mintElevenLabsSttSignedUrl,
  mintOpenRouterSessionKey,
} from "../lib/bridge-credentials";

export interface CredentialsState {
  status: "loading" | "ready" | "error";
  openRouterApiKey: string | null;
  openRouterModelId: string | null;
  ttsSignedUrl: string | null;
  ttsExpiresAt: string | null;
  sttSignedUrl: string | null;
  sttExpiresAt: string | null;
  error: string | null;
}

const INITIAL: CredentialsState = {
  status: "loading",
  openRouterApiKey: null,
  openRouterModelId: null,
  ttsSignedUrl: null,
  ttsExpiresAt: null,
  sttSignedUrl: null,
  sttExpiresAt: null,
  error: null,
};

/**
 * Mints an OpenRouter session key + the first ElevenLabs TTS / STT signed
 * URLs at startup. Subsequent re-mints are driven by the speak() WSS-close
 * pre-mint pattern and a TTL watcher.
 *
 * Returns a stable refresh function the active screen can call from the
 * speak/STT effects when they detect 401/403/expired errors.
 */
export function useCredentials(voiceId: string): CredentialsState & {
  refreshTts(): Promise<void>;
  refreshStt(): Promise<void>;
} {
  const [state, setState] = useState<CredentialsState>(INITIAL);

  useEffect(() => {
    let cancelled = false;
    setState(INITIAL);
    void (async () => {
      try {
        const [or, tts, stt] = await Promise.all([
          mintOpenRouterSessionKey(),
          mintElevenLabsSignedUrl(voiceId || undefined),
          mintElevenLabsSttSignedUrl(),
        ]);
        if (cancelled) return;
        setState({
          status: "ready",
          openRouterApiKey: or.apiKey,
          openRouterModelId: or.modelId,
          ttsSignedUrl: tts.signedUrl,
          ttsExpiresAt: tts.expiresAt,
          sttSignedUrl: stt.signedUrl,
          sttExpiresAt: stt.expiresAt,
          error: null,
        });
        log.info("bridge-credentials", "ready", {
          modelId: or.modelId,
          ttsExpiresAt: tts.expiresAt,
          sttExpiresAt: stt.expiresAt,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        log.error("bridge-credentials", "mint failed", { message });
        setState({
          ...INITIAL,
          status: "error",
          error: message,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [voiceId]);

  const refreshTts = async (): Promise<void> => {
    try {
      const fresh = await mintElevenLabsSignedUrl(voiceId || undefined);
      setState((prev) => ({
        ...prev,
        ttsSignedUrl: fresh.signedUrl,
        ttsExpiresAt: fresh.expiresAt,
      }));
    } catch (err) {
      log.warn("bridge-credentials", "tts re-mint failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const refreshStt = async (): Promise<void> => {
    try {
      const fresh = await mintElevenLabsSttSignedUrl();
      setState((prev) => ({
        ...prev,
        sttSignedUrl: fresh.signedUrl,
        sttExpiresAt: fresh.expiresAt,
      }));
    } catch (err) {
      log.warn("bridge-credentials", "stt re-mint failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { ...state, refreshTts, refreshStt };
}
