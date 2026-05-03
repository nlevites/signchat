"""MediaPipe Holistic landmark indices used by hoyso48's 1st-place asl-signs solution.

Faithful port of cell 7 of the reference notebook:
    https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution/blob/main/ISLR_1st_place_Hoyeol_Sohn.ipynb

Hoyso48's landmark indices use the ORIGINAL Kaggle row order:
    [face (0..467), left_hand (468..488), pose (489..521), right_hand (522..542)]

Our local cache (written by ``src/data/kaggle_islr_loader.py``) uses a different
canonical layout [Pose, Face, LHand, RHand]:
    pose       0..32     (33 points)
    face       33..500   (468 points)
    left hand  501..521  (21 points)
    right hand 522..542  (21 points)

This module exposes the constants in LOCAL index space (translated via
``_kaggle_to_local``), which is what the rest of the codebase consumes.

POINT_LANDMARKS = LIP(40) + LHAND(21) + RHAND(21) + NOSE(4) + REYE(16) + LEYE(16)
                = 118 landmarks. Pose and most of the face are dropped on
                  purpose; hoyso48 found they don't help and just dilute the
                  attention signal.
"""

from __future__ import annotations

import numpy as np


# Per-frame landmark counts (Kaggle row order).
N_FACE = 468
N_LHAND = 21
N_POSE = 33
N_RHAND = 21
N_TOTAL = N_FACE + N_LHAND + N_POSE + N_RHAND  # 543

# Local cache layout offsets.
LOCAL_POSE_OFFSET = 0
LOCAL_FACE_OFFSET = N_POSE
LOCAL_LHAND_OFFSET = N_POSE + N_FACE
LOCAL_RHAND_OFFSET = N_POSE + N_FACE + N_LHAND


def _kaggle_to_local(idx: int) -> int:
    """Translate a Kaggle-row-order landmark index to our local cache index."""
    if idx < 468:
        # face: 0..467 -> 33..500
        return idx + LOCAL_FACE_OFFSET
    if idx < 489:
        # left_hand: 468..488 -> 501..521
        return (idx - 468) + LOCAL_LHAND_OFFSET
    if idx < 522:
        # pose: 489..521 -> 0..32
        return (idx - 489) + LOCAL_POSE_OFFSET
    # right_hand: 522..542 -> 522..542 (identity)
    return idx


def _translate(indices):
    """Translate an iterable of Kaggle-order indices to local-order indices."""
    return [_kaggle_to_local(int(i)) for i in indices]


# --------------------------------------------------------------------------- raw kaggle indices (from hoyso48 cell 7)

# Nose subset (4 points) used as the centering reference in Preprocess.
_KAGGLE_NOSE = [1, 2, 98, 327]
_KAGGLE_LNOSE = [98]
_KAGGLE_RNOSE = [327]

_KAGGLE_LIP = [
    0,
    61, 185, 40, 39, 37, 267, 269, 270, 409,
    291, 146, 91, 181, 84, 17, 314, 405, 321, 375,
    78, 191, 80, 81, 82, 13, 312, 311, 310, 415,
    95, 88, 178, 87, 14, 317, 402, 318, 324, 308,
]
_KAGGLE_LLIP = [84, 181, 91, 146, 61, 185, 40, 39, 37, 87, 178, 88, 95, 78, 191, 80, 81, 82]
_KAGGLE_RLIP = [314, 405, 321, 375, 291, 409, 270, 269, 267, 317, 402, 318, 324, 308, 415, 310, 311, 312]

_KAGGLE_POSE = [500, 502, 504, 501, 503, 505, 512, 513]
_KAGGLE_LPOSE = [513, 505, 503, 501]
_KAGGLE_RPOSE = [512, 504, 502, 500]

# 16 right-eye points.
_KAGGLE_REYE = [
    33, 7, 163, 144, 145, 153, 154, 155, 133,
    246, 161, 160, 159, 158, 157, 173,
]
# 16 left-eye points.
_KAGGLE_LEYE = [
    263, 249, 390, 373, 374, 380, 381, 382, 362,
    466, 388, 387, 386, 385, 384, 398,
]

# Hand indices: full 21 each, in Kaggle row order (468..488 / 522..542).
_KAGGLE_LHAND = list(range(468, 468 + 21))
_KAGGLE_RHAND = list(range(522, 522 + 21))


# --------------------------------------------------------------------------- public constants (LOCAL index space)

NOSE = _translate(_KAGGLE_NOSE)
LNOSE = _translate(_KAGGLE_LNOSE)
RNOSE = _translate(_KAGGLE_RNOSE)

LIP = _translate(_KAGGLE_LIP)
LLIP = _translate(_KAGGLE_LLIP)
RLIP = _translate(_KAGGLE_RLIP)

POSE = _translate(_KAGGLE_POSE)
LPOSE = _translate(_KAGGLE_LPOSE)
RPOSE = _translate(_KAGGLE_RPOSE)

REYE = _translate(_KAGGLE_REYE)
LEYE = _translate(_KAGGLE_LEYE)

LHAND = _translate(_KAGGLE_LHAND)
RHAND = _translate(_KAGGLE_RHAND)

# The exact landmark order the model sees: lips first, then hands, then nose
# + eyes. Pose is intentionally OMITTED (hoyso48's choice).
POINT_LANDMARKS = LIP + LHAND + RHAND + NOSE + REYE + LEYE
NUM_NODES = len(POINT_LANDMARKS)            # 118
CHANNELS = 6 * NUM_NODES                    # 708

# Reference landmark used for per-clip centering (mean = nose-tip "1" in Kaggle
# row order, which is local index 1+33 = 34). Hoyso48 uses landmark 17 (face);
# we keep his exact choice so the normalization statistics match. Original
# Kaggle index 17 -> local index 50.
NOSE_REF_INDEX = _kaggle_to_local(17)


assert NUM_NODES == 118, f"expected 118 landmarks, got {NUM_NODES}"
assert len(LIP) == 40
assert len(LHAND) == 21 and len(RHAND) == 21
assert len(NOSE) == 4
assert len(REYE) == 16 and len(LEYE) == 16


# --------------------------------------------------------------------------- numpy mirrors for tf.gather

POINT_LANDMARKS_ARR = np.array(POINT_LANDMARKS, dtype=np.int32)
LHAND_ARR = np.array(LHAND, dtype=np.int32)
RHAND_ARR = np.array(RHAND, dtype=np.int32)
LLIP_ARR = np.array(LLIP, dtype=np.int32)
RLIP_ARR = np.array(RLIP, dtype=np.int32)
LPOSE_ARR = np.array(LPOSE, dtype=np.int32)
RPOSE_ARR = np.array(RPOSE, dtype=np.int32)
LEYE_ARR = np.array(LEYE, dtype=np.int32)
REYE_ARR = np.array(REYE, dtype=np.int32)
LNOSE_ARR = np.array(LNOSE, dtype=np.int32)
RNOSE_ARR = np.array(RNOSE, dtype=np.int32)
