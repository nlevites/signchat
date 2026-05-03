"use client";

import { useEffect } from "react";
import type { RoomDataMessage } from "@signchat/contracts";
import {
  usePreferencesStore,
  useRoomStore,
  useTranscriptStore,
} from "@/lib/stores";

interface SignchatDevHandle {
  publish: (msg: RoomDataMessage) => Promise<void>;
  useRoomStore: typeof useRoomStore;
  useTranscriptStore: typeof useTranscriptStore;
  usePreferencesStore: typeof usePreferencesStore;
}

declare global {
  var __signchat: SignchatDevHandle | undefined;
}

// dev-only convenience: lets the verification checklist drive the data channel
// from devtools without a chat ui. stripped from production by next's `process
// .env.NODE_ENV === "production"` constant-folding + tree-shaking.
export function useDevWindowHandle(
  publish: (msg: RoomDataMessage) => Promise<void>,
): void {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    if (typeof window === "undefined") return;
    window.__signchat = {
      publish,
      useRoomStore,
      useTranscriptStore,
      usePreferencesStore,
    };
    return () => {
      delete window.__signchat;
    };
  }, [publish]);
}
