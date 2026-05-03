"use client";

export interface DeviceList {
  audioInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
}

// browsers only return non-empty `label` after getUserMedia has been granted at
// least once for the origin — call this AFTER the first getUserMedia in the lobby.
export async function enumerateMediaDevices(): Promise<DeviceList> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return { audioInputs: [], audioOutputs: [], videoInputs: [] };
  }
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    audioInputs: all.filter((d) => d.kind === "audioinput"),
    audioOutputs: all.filter((d) => d.kind === "audiooutput"),
    videoInputs: all.filter((d) => d.kind === "videoinput"),
  };
}

export function deviceLabel(device: MediaDeviceInfo, fallback = "Default"): string {
  if (device.label) return device.label;
  if (device.deviceId === "default") return `${fallback} (system default)`;
  return `${fallback} (${device.deviceId.slice(0, 6)}…)`;
}
