"""Webcam clip recorder.

Captures short clips from the webcam, runs MediaPipe Holistic on every frame,
and writes:
  data/raw/<signer_id>/<sign>/<timestamp>.mp4         (video for re-extraction)
  data/cache/landmarks/<signer_id>/<sign>/<timestamp>.npy   (T, 543, 3) landmarks

Cache layout matches what tfrecords.py expects so training can read it directly.

Usage:
    python -m src.data.record_clips
    python -m src.data.record_clips --signer alex --vocab hello,thanks,please
    python -m src.data.record_clips --signer signer_eval        # capture for eval set
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import cv2
import numpy as np

from .mediapipe_runner import extract_clip, holistic_session

DEFAULT_VOCAB = ["hello", "thanks", "please"]
DEFAULT_DURATION_S = 2.0


def _draw_overlay(frame, sign: str, status: str, count: int):
    h, w = frame.shape[:2]
    cv2.rectangle(frame, (0, 0), (w, 60), (0, 0, 0), -1)
    cv2.putText(frame, f"sign: {sign}   recorded: {count}", (10, 25),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)
    cv2.putText(frame, status, (10, 50),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)


def _save_video(path: Path, frames: list[np.ndarray], fps: float):
    if not frames:
        return
    h, w = frames[0].shape[:2]
    path.parent.mkdir(parents=True, exist_ok=True)
    fourcc = cv2.VideoWriter_fourcc(*"mp4v")
    writer = cv2.VideoWriter(str(path), fourcc, fps, (w, h))
    for f in frames:
        writer.write(f)
    writer.release()


def _save_landmarks(path: Path, arr: np.ndarray):
    path.parent.mkdir(parents=True, exist_ok=True)
    np.save(path, arr)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--signer", default="signer_default",
                        help="signer id; use 'signer_eval' for the held-out eval set")
    parser.add_argument("--vocab", default=",".join(DEFAULT_VOCAB),
                        help="comma-separated list of signs to record")
    parser.add_argument("--duration", type=float, default=DEFAULT_DURATION_S,
                        help="clip length in seconds")
    parser.add_argument("--raw-dir", default="data/raw")
    parser.add_argument("--cache-dir", default="data/cache/landmarks")
    parser.add_argument("--device", type=int, default=0, help="webcam index")
    args = parser.parse_args()

    vocab = [s.strip() for s in args.vocab.split(",") if s.strip()]
    raw_root = Path(args.raw_dir) / args.signer
    cache_root = Path(args.cache_dir) / args.signer

    cap = cv2.VideoCapture(args.device)
    if not cap.isOpened():
        raise RuntimeError(f"could not open webcam {args.device}")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0

    counts = {s: 0 for s in vocab}
    sign_idx = 0
    state = "idle"
    rec_frames: list[np.ndarray] = []
    rec_started = 0.0

    print("controls:  SPACE=start clip   N=next sign   Q=quit")
    with holistic_session() as holistic:
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            frame = cv2.flip(frame, 1)
            sign = vocab[sign_idx]

            if state == "recording":
                rec_frames.append(frame.copy())
                if time.time() - rec_started >= args.duration:
                    ts = int(time.time() * 1000)
                    landmarks = extract_clip(holistic, rec_frames)
                    _save_video(raw_root / sign / f"{ts}.mp4", rec_frames, fps)
                    _save_landmarks(cache_root / sign / f"{ts}.npy", landmarks)
                    counts[sign] += 1
                    print(f"  saved {sign} #{counts[sign]} ({len(rec_frames)} frames)")
                    rec_frames = []
                    state = "idle"

            display = frame.copy()
            _draw_overlay(display, sign, state, counts[sign])
            cv2.imshow("record_clips", display)

            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                break
            elif key == ord(" ") and state == "idle":
                state = "recording"
                rec_started = time.time()
                rec_frames = []
            elif key == ord("n"):
                sign_idx = (sign_idx + 1) % len(vocab)
                state = "idle"
                rec_frames = []

    cap.release()
    cv2.destroyAllWindows()
    print("\nrecorded counts per sign:")
    for s, c in counts.items():
        print(f"  {s:12s} {c}")


if __name__ == "__main__":
    main()
