"use client";

import {
  type AudioCaptureOptions,
  createLocalTracks,
  type LocalAudioTrack,
  type LocalTrack,
  type LocalTrackPublication,
  type LocalVideoTrack,
  type Room,
  Track,
  type VideoCaptureOptions,
} from "livekit-client";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";

/**
 * Publish the local Deaf or Hearing user's camera + microphone tracks to the
 * already-connected LiveKit Room.
 *
 * Phase-4 seam: §8 of ARCHITECTURE.md says the Deaf participant publishes
 * exactly one outgoing audio track named `signchat-voice` — a Web Audio mix
 * of the live mic and the streamed TTS PCM. Phase 2 does NOT do that mix; it
 * publishes the raw mic with the SDK defaults so the workbench's LiveKit pane
 * can prove the publish path end-to-end. Phase 4 will replace this mic
 * publish for the Deaf role with the `MediaStreamDestination` track from the
 * audio mixer (and flip dtx=false / red=true / audioPreset=speech per §8.2).
 * Hearing-role publish stays as is forever — the Hearing user only ever
 * publishes a normal mic track.
 */

export interface PublishedLocalTracks {
  video: LocalVideoTrack | null;
  videoPub: LocalTrackPublication | null;
  audio: LocalAudioTrack | null;
  audioPub: LocalTrackPublication | null;
  /** Stop the underlying MediaStream tracks and unpublish them. */
  unpublish: () => Promise<void>;
}

export interface PublishLocalCameraAndMicArgs {
  /** Override of the default video constraints. Use `false` to skip video. */
  video?: boolean | VideoCaptureOptions;
  /** Override of the default audio constraints. Use `false` to skip audio. */
  audio?: boolean | AudioCaptureOptions;
}

const DEFAULT_AUDIO: AudioCaptureOptions = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const DEFAULT_VIDEO: VideoCaptureOptions = {
  resolution: { width: 1280, height: 720, frameRate: 30 },
};

export async function publishLocalCameraAndMic(
  room: Room,
  args: PublishLocalCameraAndMicArgs = {},
): Promise<PublishedLocalTracks> {
  const audioOpt = args.audio ?? DEFAULT_AUDIO;
  const videoOpt = args.video ?? DEFAULT_VIDEO;

  let tracks: LocalTrack[];
  try {
    tracks = await createLocalTracks({ audio: audioOpt, video: videoOpt });
  } catch (err) {
    LogBus.error("livekit", "createLocalTracks failed", {
      error: errMsg(err),
    });
    if (err instanceof DOMException && err.name === "NotAllowedError") {
      throw new Error(
        "camera/microphone permission denied — grant access and retry",
      );
    }
    throw err;
  }

  let videoTrack: LocalVideoTrack | null = null;
  let audioTrack: LocalAudioTrack | null = null;
  for (const t of tracks) {
    if (t.kind === Track.Kind.Video) {
      videoTrack = t as LocalVideoTrack;
    } else if (t.kind === Track.Kind.Audio) {
      audioTrack = t as LocalAudioTrack;
    }
  }

  let videoPub: LocalTrackPublication | null = null;
  let audioPub: LocalTrackPublication | null = null;

  if (videoTrack) {
    const turnId = newTurnId();
    mark("livekit.publish.video", turnId, "start");
    try {
      videoPub = await room.localParticipant.publishTrack(
        videoTrack as LocalTrack,
        {
          source: Track.Source.Camera,
          name: "camera",
        },
      );
      mark("livekit.publish.video", turnId, "end");
      LogBus.info("livekit", "published camera", {
        sid: videoPub.trackSid,
      });
    } catch (err) {
      mark("livekit.publish.video", turnId, "end");
      LogBus.error("livekit", "publish camera failed", { error: errMsg(err) });
      videoTrack.stop();
      throw err;
    }
  }

  if (audioTrack) {
    const turnId = newTurnId();
    mark("livekit.publish.audio", turnId, "start");
    try {
      audioPub = await room.localParticipant.publishTrack(
        audioTrack as LocalTrack,
        {
          source: Track.Source.Microphone,
          name: "microphone",
          // Phase-2 defaults. Phase 4 will override for Deaf-role with:
          //   { dtx: false, red: true, audioPreset: AudioPresets.speech, name: "signchat-voice" }
          // and pass the MediaStreamDestination track from §8.1 instead of the
          // raw mic LocalAudioTrack here.
        },
      );
      mark("livekit.publish.audio", turnId, "end");
      LogBus.info("livekit", "published microphone", {
        sid: audioPub.trackSid,
      });
    } catch (err) {
      mark("livekit.publish.audio", turnId, "end");
      LogBus.error("livekit", "publish microphone failed", {
        error: errMsg(err),
      });
      audioTrack.stop();
      throw err;
    }
  }

  const unpublish = async () => {
    const lp = room.localParticipant;
    const toUnpublish: LocalTrack[] = [];
    if (videoTrack) toUnpublish.push(videoTrack as LocalTrack);
    if (audioTrack) toUnpublish.push(audioTrack as LocalTrack);
    try {
      await lp.unpublishTracks(toUnpublish);
    } catch (err) {
      LogBus.warn("livekit", "unpublishTracks threw (ignored)", {
        error: errMsg(err),
      });
    }
    for (const t of toUnpublish) {
      try {
        t.stop();
      } catch {
        // best-effort
      }
    }
  };

  return {
    video: videoTrack,
    videoPub,
    audio: audioTrack,
    audioPub,
    unpublish,
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
