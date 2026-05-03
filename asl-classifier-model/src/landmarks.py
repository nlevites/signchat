"""MediaPipe Holistic landmark index map for the 130-point subset.

Holistic landmark layout (in the order our MediaPipe extractor concatenates):
    [0      .. 33)    pose       (33 points)
    [33     .. 501)   face       (468 points; canonical FaceMesh order)
    [501    .. 522)   left hand  (21 points)
    [522    .. 543)   right hand (21 points)

The 130-landmark subset = 76 face + 12 pose + 42 hands. This mirrors the
n_landmarks=130 convention used by the Kaggle ASL Fingerspelling 1st-place
solution (Christof Henkel / Darragh Hanley, Apache-2.0):
    https://github.com/ChristofHenkel/kaggle-asl-fingerspelling-1st-place-solution

Face indices are derived from MediaPipe's published FaceMesh topology:
    https://github.com/google/mediapipe/blob/master/mediapipe/python/solutions/face_mesh_connections.py
"""

from __future__ import annotations

import numpy as np


N_POSE = 33
N_FACE = 468
N_HAND = 21
N_TOTAL = N_POSE + N_FACE + 2 * N_HAND  # 543

POSE_OFFSET = 0
FACE_OFFSET = N_POSE
LHAND_OFFSET = N_POSE + N_FACE
RHAND_OFFSET = N_POSE + N_FACE + N_HAND

POSE_UPPER_BODY = [
    11, 12,           # shoulders
    13, 14,           # elbows
    15, 16,           # wrists
    17, 18,           # pinkies
    19, 20,           # index
    21, 22,           # thumbs
]
assert len(POSE_UPPER_BODY) == 12

FACE_LIPS_OUTER = [
    61, 146, 91, 181, 84, 17, 314, 405, 321, 375,
    291, 409, 270, 269, 267, 0, 37, 39, 40, 185,
]
FACE_LIPS_INNER = [
    78, 95, 88, 178, 87, 14, 317, 402, 318, 324,
    308, 415, 310, 311, 312, 13, 82, 81, 80, 191,
]
FACE_LIPS = FACE_LIPS_OUTER + FACE_LIPS_INNER  # 40

FACE_LEFT_EYE = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173]
FACE_RIGHT_EYE = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398]
FACE_EYES = FACE_LEFT_EYE + FACE_RIGHT_EYE  # 20

FACE_NOSE = [1, 2, 5, 4, 19, 94, 168, 6]  # 8

FACE_OVAL = [10, 152, 234, 454, 127, 356, 162, 389]  # 8

FACE_INDICES = FACE_LIPS + FACE_EYES + FACE_NOSE + FACE_OVAL
assert len(FACE_INDICES) == 76

LEFT_HAND_INDICES = list(range(N_HAND))   # all 21
RIGHT_HAND_INDICES = list(range(N_HAND))  # all 21


def build_selected_columns() -> np.ndarray:
    """Return indices into the (T, 543, 3) Holistic tensor for the 130 subset.

    Order: [hands_left (21), hands_right (21), pose (12), face (76)] = 130.
    """
    cols: list[int] = []
    cols += [LHAND_OFFSET + i for i in LEFT_HAND_INDICES]
    cols += [RHAND_OFFSET + i for i in RIGHT_HAND_INDICES]
    cols += [POSE_OFFSET + i for i in POSE_UPPER_BODY]
    cols += [FACE_OFFSET + i for i in FACE_INDICES]
    arr = np.array(cols, dtype=np.int32)
    assert arr.shape == (130,)
    return arr


SELECTED_COLUMNS = build_selected_columns()


# Slice ranges within the 130-subset output, used by handedness flip + landmark
# group augmentations.
SUBSET_LHAND = slice(0, 21)
SUBSET_RHAND = slice(21, 42)
SUBSET_POSE = slice(42, 54)
SUBSET_FACE = slice(54, 130)


def build_flip_permutation() -> np.ndarray:
    """Permutation that, applied to the 130-subset along the landmark axis,
    swaps left and right anatomical structures (used after mirroring x).

    Hands: swap left and right blocks. Pose: swap pairs (left index, right index).
    Face: lips/nose/oval are roughly symmetric in our chosen index list, so we
    swap the eye blocks (which we ordered as [left_eye, right_eye]).
    """
    perm = np.arange(130, dtype=np.int32)

    perm[SUBSET_LHAND], perm[SUBSET_RHAND] = (
        np.arange(21, 42, dtype=np.int32),
        np.arange(0, 21, dtype=np.int32),
    )

    pose_pairs = [(0, 1), (2, 3), (4, 5), (6, 7), (8, 9), (10, 11)]
    for a, b in pose_pairs:
        perm[42 + a] = 42 + b
        perm[42 + b] = 42 + a

    eye_lo = 54 + len(FACE_LIPS)               # 94
    eye_hi = eye_lo + len(FACE_EYES)           # 114
    eye_left = np.arange(eye_lo, eye_lo + 10, dtype=np.int32)
    eye_right = np.arange(eye_lo + 10, eye_hi, dtype=np.int32)
    perm[eye_lo:eye_lo + 10] = eye_right
    perm[eye_lo + 10:eye_hi] = eye_left

    return perm


FLIP_PERMUTATION = build_flip_permutation()
