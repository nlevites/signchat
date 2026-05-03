import { contextBridge, ipcRenderer, shell } from "electron";

/**
 * Minimal preload surface. Bridge does almost everything in the renderer
 * (Chromium APIs reach the camera, BlackHole devices, ElevenLabs WSS, and
 * OpenRouter directly). The few things the renderer can't do are exposed
 * here under `window.bridgeApi`.
 */

const api = {
  /** Open an external URL in the user's default browser. */
  openExternal(url: string): Promise<void> {
    return shell.openExternal(url);
  },
  /** Write to the OS clipboard (used to copy the brew install command). */
  writeClipboard(text: string): Promise<void> {
    return ipcRenderer.invoke("clipboard:write", text);
  },
  /** Bridge version + platform info, useful for the footer / About. */
  meta(): { platform: NodeJS.Platform; appVersion: string } {
    return {
      platform: process.platform,
      appVersion: process.env.npm_package_version ?? "dev",
    };
  },
};

contextBridge.exposeInMainWorld("bridgeApi", api);
