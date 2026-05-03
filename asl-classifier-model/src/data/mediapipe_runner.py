"""Thin wrapper around MediaPipe Holistic that produces (T, 543, 3) numpy arrays.

Used both by the offline cache builders (record_clips, wlasl_raw_loader) and by
the realtime demo. Centralized here so the landmark layout never disagrees.
"""

from __future__ import annotations

import contextlib

import numpy as np

import mediapipe as mp

from .. import landmarks as lm

_mp_holistic = mp.solutions.holistic


@contextlib.contextmanager
def holistic_session(model_complexity: int = 2,
                     min_detection_confidence: float = 0.5,
                     min_tracking_confidence: float = 0.5):
    """Context-managed MediaPipe Holistic session.

    `model_complexity=2` matches the heaviest/most-accurate Holistic model and
    aligns with the MuteMotion pre-extracted dataset's likely settings, so
    landmarks at training time and at webcam-inference time come from
    equivalent extractors. Costs ~2x latency vs complexity=1 (still fine for
    realtime on M-series silicon at ~15-25 FPS).
    """
    with _mp_holistic.Holistic(
        static_image_mode=False,
        model_complexity=model_complexity,
        smooth_landmarks=True,
        refine_face_landmarks=False,
        min_detection_confidence=min_detection_confidence,
        min_tracking_confidence=min_tracking_confidence,
    ) as h:
        yield h


def landmarks_from_result(result) -> np.ndarray:
    """Convert one Holistic result to a (543, 3) array, NaN for missing parts."""
    out = np.full((lm.N_TOTAL, 3), np.nan, dtype=np.float32)

    if result.pose_landmarks is not None:
        for i, p in enumerate(result.pose_landmarks.landmark):
            out[lm.POSE_OFFSET + i] = (p.x, p.y, p.z)

    if result.face_landmarks is not None:
        for i, p in enumerate(result.face_landmarks.landmark):
            out[lm.FACE_OFFSET + i] = (p.x, p.y, p.z)

    if result.left_hand_landmarks is not None:
        for i, p in enumerate(result.left_hand_landmarks.landmark):
            out[lm.LHAND_OFFSET + i] = (p.x, p.y, p.z)

    if result.right_hand_landmarks is not None:
        for i, p in enumerate(result.right_hand_landmarks.landmark):
            out[lm.RHAND_OFFSET + i] = (p.x, p.y, p.z)

    return out


def extract_clip(holistic, frames_bgr: list[np.ndarray]) -> np.ndarray:
    """Run Holistic over a list of BGR frames; return (T, 543, 3)."""
    import cv2
    seq = []
    for frame in frames_bgr:
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = holistic.process(rgb)
        seq.append(landmarks_from_result(result))
    return np.stack(seq, axis=0) if seq else np.zeros((0, lm.N_TOTAL, 3), dtype=np.float32)
