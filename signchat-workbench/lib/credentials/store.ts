"use client";

import { useSyncExternalStore } from "react";
import type {
  MintElevenLabsSignedUrlResponse,
  MintLiveKitTokenResponse,
  MintOpenRouterSessionKeyResponse,
  Role,
} from "@/lib/contracts";

/**
 * Browser-side credentials cache. Populated by the Lobby pane after a
 * successful mint; consumed by Phase 2/3/4 panes (LiveKit, OpenRouter,
 * ElevenLabs) so each one doesn't re-mint independently.
 *
 * Mirrors the LogBus + LatencyStore pattern: external store + cached
 * snapshot + useSyncExternalStore for stable identity across renders.
 *
 * Lifecycle: in-memory only. Never written to localStorage. Cleared on tab
 * close, on `clear()`, or when the user changes role / room.
 */

export interface CredentialContext {
  /** Sanitized room id used to mint. */
  roomId: string;
  /** Sanitized identity used to mint. */
  identity: string;
  /** Role used to mint; "hearing" only mints LiveKit. */
  role: Role;
}

export interface CredentialBundle {
  context: CredentialContext | null;
  livekit: MintLiveKitTokenResponse | null;
  openrouter: MintOpenRouterSessionKeyResponse | null;
  elevenlabs: MintElevenLabsSignedUrlResponse | null;
  /** Wall-clock ms when the most recent mint completed. */
  mintedAt: number | null;
}

const EMPTY_BUNDLE: CredentialBundle = {
  context: null,
  livekit: null,
  openrouter: null,
  elevenlabs: null,
  mintedAt: null,
};

class CredentialStoreImpl {
  private bundle: CredentialBundle = EMPTY_BUNDLE;
  private subscribers = new Set<() => void>();

  setContext(context: CredentialContext): void {
    // Changing context invalidates all credentials (they were minted for the
    // old room/identity). Callers re-mint after setContext.
    if (
      this.bundle.context &&
      contextEquals(this.bundle.context, context)
    ) {
      return;
    }
    this.bundle = {
      context,
      livekit: null,
      openrouter: null,
      elevenlabs: null,
      mintedAt: null,
    };
    this.notify();
  }

  setLiveKit(value: MintLiveKitTokenResponse): void {
    this.bundle = { ...this.bundle, livekit: value, mintedAt: Date.now() };
    this.notify();
  }

  setOpenRouter(value: MintOpenRouterSessionKeyResponse): void {
    this.bundle = { ...this.bundle, openrouter: value, mintedAt: Date.now() };
    this.notify();
  }

  setElevenLabs(value: MintElevenLabsSignedUrlResponse): void {
    this.bundle = { ...this.bundle, elevenlabs: value, mintedAt: Date.now() };
    this.notify();
  }

  clear(): void {
    this.bundle = EMPTY_BUNDLE;
    this.notify();
  }

  snapshot(): CredentialBundle {
    return this.bundle;
  }

  subscribe(cb: () => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.subscribers) {
      try {
        cb();
      } catch {
        // ignore subscriber faults
      }
    }
  }
}

function contextEquals(a: CredentialContext, b: CredentialContext): boolean {
  return a.roomId === b.roomId && a.identity === b.identity && a.role === b.role;
}

export const CredentialStore = new CredentialStoreImpl();

const subscribeCreds = (cb: () => void) => CredentialStore.subscribe(cb);
const getCredentialsSnapshot = () => CredentialStore.snapshot();
const getServerCredentialsSnapshot = () => EMPTY_BUNDLE;

export function useCredentials(): CredentialBundle {
  return useSyncExternalStore(
    subscribeCreds,
    getCredentialsSnapshot,
    getServerCredentialsSnapshot,
  );
}
