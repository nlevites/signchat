"use client";

import {
  ConnectionState as LKConnectionState,
  type LocalAudioTrack,
  type LocalVideoTrack,
  LogLevel,
  type RemoteAudioTrack,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type RemoteVideoTrack,
  Room,
  RoomEvent,
  setLogLevel,
  Track,
} from "livekit-client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Role } from "@signchat/contracts";
import {
  type ConnectionState as RoomConnectionState,
  useRoomStore,
} from "@/lib/stores";
import { toast } from "@/lib/stores/toast";

export interface UseLiveKitRoomArgs {
  audioInputDeviceId: string;
  videoInputDeviceId: string;
  audioOutputDeviceId: string;
  initialMicEnabled: boolean;
  initialCamEnabled: boolean;
}

export interface LiveKitRoomState {
  room: Room | null;
  localVideoTrack: LocalVideoTrack | null;
  localAudioTrack: LocalAudioTrack | null;
  remoteVideoTrack: RemoteVideoTrack | null;
  remoteAudioTrack: RemoteAudioTrack | null;
  remoteIdentity: string | null;
  remoteName: string | null;
  remoteRole: Role | null;
  micEnabled: boolean;
  camEnabled: boolean;
  toggleMic: () => Promise<void>;
  toggleCamera: () => Promise<void>;
  leave: () => Promise<void>;
}

// livekit logs at warn for normal lifecycle events ("Abort connection attempt
// due to user initiated disconnect", "websocket closed code 1006") that fire
// during react strict-mode's intentional double-effect dance in dev. drop the
// floor to error so only real failures reach the console.
let logLevelSet = false;
function ensureLiveKitLogLevel(): void {
  if (logLevelSet) return;
  logLevelSet = true;
  setLogLevel(LogLevel.error);
}

function mapConnectionState(s: LKConnectionState): RoomConnectionState {
  switch (s) {
    case LKConnectionState.Connected:
      return "connected";
    case LKConnectionState.Connecting:
      return "connecting";
    case LKConnectionState.Reconnecting:
    case LKConnectionState.SignalReconnecting:
      return "reconnecting";
    case LKConnectionState.Disconnected:
    default:
      return "disconnected";
  }
}

function parseRoleFromMetadata(metadata: string | undefined): Role | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { role?: unknown };
    if (parsed.role === "deaf" || parsed.role === "hearing") return parsed.role;
  } catch {
    // metadata isn't json — ignore
  }
  return null;
}

export function useLiveKitRoom(args: UseLiveKitRoomArgs): LiveKitRoomState {
  const wsUrl = useRoomStore((s) => s.wsUrl);
  const token = useRoomStore((s) => s.token);
  const role = useRoomStore((s) => s.role);
  const setConnectionState = useRoomStore((s) => s.setConnectionState);
  const setRemoteParticipant = useRoomStore((s) => s.setRemoteParticipant);

  const roomRef = useRef<Room | null>(null);
  const remoteIdentityRef = useRef<string | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(
    null,
  );
  const [localAudioTrack, setLocalAudioTrack] = useState<LocalAudioTrack | null>(
    null,
  );
  const [remoteVideoTrack, setRemoteVideoTrack] =
    useState<RemoteVideoTrack | null>(null);
  const [remoteAudioTrack, setRemoteAudioTrack] =
    useState<RemoteAudioTrack | null>(null);
  const [remoteIdentity, setRemoteIdentity] = useState<string | null>(null);
  const [remoteName, setRemoteName] = useState<string | null>(null);
  const [remoteRole, setRemoteRole] = useState<Role | null>(null);
  const [micEnabled, setMicEnabled] = useState(args.initialMicEnabled);
  const [camEnabled, setCamEnabled] = useState(args.initialCamEnabled);

  // seeds for the first connect — referenced from inside the effect below so
  // that mid-call device changes don't trigger a reconnect.
  const seedsRef = useRef(args);
  seedsRef.current = args;

  useEffect(() => {
    if (!wsUrl || !token || !role) return;
    ensureLiveKitLogLevel();
    const seeds = seedsRef.current;

    let cancelled = false;
    const r = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        ...(seeds.audioInputDeviceId
          ? { deviceId: seeds.audioInputDeviceId }
          : {}),
      },
      videoCaptureDefaults: {
        resolution: { width: 1280, height: 720, frameRate: 30 },
        ...(seeds.videoInputDeviceId
          ? { deviceId: seeds.videoInputDeviceId }
          : {}),
      },
    });

    const refreshLocalTracks = () => {
      const camPub = r.localParticipant.getTrackPublication(Track.Source.Camera);
      const micPub = r.localParticipant.getTrackPublication(
        Track.Source.Microphone,
      );
      setLocalVideoTrack((camPub?.videoTrack as LocalVideoTrack | null) ?? null);
      setLocalAudioTrack((micPub?.audioTrack as LocalAudioTrack | null) ?? null);
    };

    const captureRemote = (p: RemoteParticipant) => {
      remoteIdentityRef.current = p.identity;
      const parsedRole = parseRoleFromMetadata(p.metadata);
      setRemoteIdentity(p.identity);
      setRemoteName(p.name ?? p.identity);
      setRemoteRole(parsedRole);
      setRemoteParticipant({
        identity: p.identity,
        name: p.name ?? p.identity,
        role: parsedRole ?? "hearing",
      });
      const videoPub = p.getTrackPublication(Track.Source.Camera);
      const audioPub = p.getTrackPublication(Track.Source.Microphone);
      setRemoteVideoTrack(
        (videoPub?.videoTrack as RemoteVideoTrack | null) ?? null,
      );
      setRemoteAudioTrack(
        (audioPub?.audioTrack as RemoteAudioTrack | null) ?? null,
      );
    };
    const clearRemote = () => {
      remoteIdentityRef.current = null;
      setRemoteIdentity(null);
      setRemoteName(null);
      setRemoteRole(null);
      setRemoteVideoTrack(null);
      setRemoteAudioTrack(null);
      setRemoteParticipant(null);
    };

    const onConnectionStateChanged = (state: LKConnectionState) => {
      setConnectionState(mapConnectionState(state));
    };
    const onParticipantConnected = (p: RemoteParticipant) => captureRemote(p);
    const onParticipantDisconnected = (p: RemoteParticipant) => {
      if (p.identity === remoteIdentityRef.current) clearRemote();
    };
    const onTrackSubscribed = (
      track: RemoteTrack,
      _pub: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      remoteIdentityRef.current = participant.identity;
      if (track.kind === Track.Kind.Video) {
        setRemoteVideoTrack(track as RemoteVideoTrack);
      } else if (track.kind === Track.Kind.Audio) {
        setRemoteAudioTrack(track as RemoteAudioTrack);
      }
    };
    const onTrackUnsubscribed = (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Video) setRemoteVideoTrack(null);
      else if (track.kind === Track.Kind.Audio) setRemoteAudioTrack(null);
    };
    const onLocalTrackPublished = () => refreshLocalTracks();
    const onLocalTrackUnpublished = () => refreshLocalTracks();
    const onDisconnected = () => {
      setConnectionState("disconnected");
      clearRemote();
    };

    r.on(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
    r.on(RoomEvent.ParticipantConnected, onParticipantConnected);
    r.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    r.on(RoomEvent.TrackSubscribed, onTrackSubscribed);
    r.on(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
    r.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
    r.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
    r.on(RoomEvent.Disconnected, onDisconnected);

    (async () => {
      try {
        await r.connect(wsUrl, token, { autoSubscribe: true });
        if (cancelled) {
          await r.disconnect(true);
          return;
        }
        roomRef.current = r;
        setRoom(r);

        await r.localParticipant.setCameraEnabled(seeds.initialCamEnabled);
        // both roles publish a raw mic. for deaf users this carries ambient
        // audio (e.g. a hearing friend in the same room). step-05.5 swaps this
        // for the signchat-voice mixer track that combines this same mic input
        // with synthesized tts.
        await r.localParticipant.setMicrophoneEnabled(seeds.initialMicEnabled);
        if (seeds.audioOutputDeviceId) {
          try {
            await r.switchActiveDevice("audiooutput", seeds.audioOutputDeviceId);
          } catch {
            // setSinkId not supported on every browser — non-fatal
          }
        }
        refreshLocalTracks();
        for (const p of r.remoteParticipants.values()) captureRemote(p);
      } catch (err) {
        // strict-mode double-effect (or any fast unmount) tears down the room
        // mid-connect and livekit throws "Client initiated disconnect". swallow
        // — the second effect re-connects cleanly. only surface real failures.
        if (cancelled) return;
        console.error("[room] connect failed", err);
        setConnectionState("disconnected");
        toast.error("Could not connect to the room — try again.");
        try {
          await r.disconnect(true);
        } catch {
          // best effort
        }
      }
    })();

    return () => {
      cancelled = true;
      r.off(RoomEvent.ConnectionStateChanged, onConnectionStateChanged);
      r.off(RoomEvent.ParticipantConnected, onParticipantConnected);
      r.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      r.off(RoomEvent.TrackSubscribed, onTrackSubscribed);
      r.off(RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      r.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      r.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      r.off(RoomEvent.Disconnected, onDisconnected);
      void r.disconnect(true);
      roomRef.current = null;
      remoteIdentityRef.current = null;
      setRoom(null);
      setLocalVideoTrack(null);
      setLocalAudioTrack(null);
      setRemoteVideoTrack(null);
      setRemoteAudioTrack(null);
      setRemoteIdentity(null);
      setRemoteName(null);
      setRemoteRole(null);
    };
  }, [wsUrl, token, role, setConnectionState, setRemoteParticipant]);

  const toggleMic = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !micEnabled;
    try {
      await r.localParticipant.setMicrophoneEnabled(next);
      setMicEnabled(next);
    } catch (err) {
      console.error("[room] mic toggle failed", err);
      toast.error("Could not toggle the microphone.");
    }
  }, [micEnabled]);

  const toggleCamera = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    const next = !camEnabled;
    try {
      await r.localParticipant.setCameraEnabled(next);
      setCamEnabled(next);
    } catch (err) {
      console.error("[room] camera toggle failed", err);
      toast.error("Could not toggle the camera.");
    }
  }, [camEnabled]);

  const leave = useCallback(async () => {
    const r = roomRef.current;
    if (!r) return;
    try {
      await r.disconnect(true);
    } catch {
      // best-effort
    }
  }, []);

  return {
    room,
    localVideoTrack,
    localAudioTrack,
    remoteVideoTrack,
    remoteAudioTrack,
    remoteIdentity,
    remoteName,
    remoteRole,
    micEnabled,
    camEnabled,
    toggleMic,
    toggleCamera,
    leave,
  };
}
