export interface BridgeApi {
  openExternal(url: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
  meta(): { platform: NodeJS.Platform; appVersion: string };
}

declare global {
  interface Window {
    bridgeApi: BridgeApi;
  }
}

export {};
