"""Per-clip preprocessing for the hoyso48 1st-place port.

Faithful port of cell 7 of the reference notebook:
    https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution/blob/main/ISLR_1st_place_Hoyeol_Sohn.ipynb

Pipeline (operates on raw (T, 543, 3) MediaPipe Holistic landmarks in our
LOCAL [Pose, Face, LHand, RHand] cache layout):

    1. NaN-mean center using the nose-tip reference (landmark 17 in the
       original Kaggle row order, local index 50). If the reference is
       all-NaN, fall back to 0.5 (image-center).
    2. Gather only the 118 POINT_LANDMARKS the model uses.
    3. NaN-std normalize.
    4. Drop z; keep only (x, y).
    5. Compute first-difference dx (1-step) and second-difference dx2
       (2-step), each padded to length T at the tail.
    6. Concat along the last axis: [x, dx, dx2] -> shape (T, 6 * NUM_NODES).
    7. Replace any remaining NaN with 0.

Output shape is (T, 708) for NUM_NODES=118. Note hoyso48's preprocessing
intentionally drops z entirely; only the 6 channels (x, y, dx, dy, dx2_x,
dx2_y) are passed to the model.
"""

from __future__ import annotations

import tensorflow as tf

from .landmarks import (
    CHANNELS,
    NOSE_REF_INDEX,
    NUM_NODES,
    POINT_LANDMARKS,
)


PAD = -100.0


def tf_nan_mean(x: tf.Tensor, axis=0, keepdims: bool = False) -> tf.Tensor:
    """NaN-aware mean along `axis`. Replaces NaNs with 0 in the numerator and
    counts only non-NaN entries in the denominator. Faithful copy of cell 7."""
    is_nan = tf.math.is_nan(x)
    num = tf.reduce_sum(tf.where(is_nan, tf.zeros_like(x), x), axis=axis, keepdims=keepdims)
    den = tf.reduce_sum(tf.where(is_nan, tf.zeros_like(x), tf.ones_like(x)),
                        axis=axis, keepdims=keepdims)
    return num / den


def tf_nan_std(x: tf.Tensor, center=None, axis=0, keepdims: bool = False) -> tf.Tensor:
    """NaN-aware std along `axis` around an optional `center`."""
    if center is None:
        center = tf_nan_mean(x, axis=axis, keepdims=True)
    d = x - center
    return tf.math.sqrt(tf_nan_mean(d * d, axis=axis, keepdims=keepdims))


class Preprocess(tf.keras.layers.Layer):
    """tf.keras layer that maps raw (T, 543, 3) landmarks -> (T, 708) features.

    Faithful port of hoyso48's `Preprocess`. Optionally truncates to `max_len`
    frames (caller-controlled; the augment pipeline already does temporal_crop
    so this is normally a no-op).
    """

    def __init__(self, max_len: int | None = None,
                 point_landmarks: list[int] | None = None,
                 nose_ref_index: int = NOSE_REF_INDEX, **kwargs):
        super().__init__(**kwargs)
        self.max_len = max_len
        self.point_landmarks = list(point_landmarks) if point_landmarks is not None else list(POINT_LANDMARKS)
        self.nose_ref_index = int(nose_ref_index)

    def call(self, inputs: tf.Tensor) -> tf.Tensor:
        # Accept (T, 543, 3) or (B, T, 543, 3); always return (B, T', C).
        if tf.rank(inputs) == 3:
            x = inputs[None, ...]
        else:
            x = inputs

        # Centering: NaN-mean over T,landmarks of the reference landmark.
        ref = tf.gather(x, [self.nose_ref_index], axis=2)
        mean = tf_nan_mean(ref, axis=[1, 2], keepdims=True)
        mean = tf.where(tf.math.is_nan(mean), tf.constant(0.5, x.dtype), mean)

        # Subset.
        x = tf.gather(x, self.point_landmarks, axis=2)               # (B, T, P, 3)
        std = tf_nan_std(x, center=mean, axis=[1, 2], keepdims=True)
        x = (x - mean) / std

        if self.max_len is not None:
            x = x[:, : self.max_len]

        length = tf.shape(x)[1]
        # Drop z. Keep only (x, y).
        x = x[..., :2]                                               # (B, T, P, 2)

        # First-difference (1-step) and second-difference (2-step). Both
        # padded at the tail to length T so the time axis stays aligned.
        dx = tf.cond(
            tf.shape(x)[1] > 1,
            lambda: tf.pad(x[:, 1:] - x[:, :-1], [[0, 0], [0, 1], [0, 0], [0, 0]]),
            lambda: tf.zeros_like(x),
        )
        dx2 = tf.cond(
            tf.shape(x)[1] > 2,
            lambda: tf.pad(x[:, 2:] - x[:, :-2], [[0, 0], [0, 2], [0, 0], [0, 0]]),
            lambda: tf.zeros_like(x),
        )

        n_pts = len(self.point_landmarks)
        x = tf.concat([
            tf.reshape(x, (-1, length, 2 * n_pts)),
            tf.reshape(dx, (-1, length, 2 * n_pts)),
            tf.reshape(dx2, (-1, length, 2 * n_pts)),
        ], axis=-1)                                                  # (B, T, 6 * P)

        x = tf.where(tf.math.is_nan(x), tf.constant(0.0, x.dtype), x)
        return x


# --------------------------------------------------------------------------- helpers used by tf.data

def filter_nans_tf(x: tf.Tensor, ref_landmarks=None) -> tf.Tensor:
    """Drop frames where every reference landmark is NaN.

    Hoyso48 calls this before augmentation so resampling/cropping operate on
    only meaningful frames. He uses POINT_LANDMARKS as the reference set,
    matching the on-disk layout where MediaPipe failed-to-detect frames are
    written as all-NaN.
    """
    if ref_landmarks is None:
        ref_landmarks = POINT_LANDMARKS
    ref = tf.gather(x, ref_landmarks, axis=1)
    keep = tf.math.logical_not(tf.reduce_all(tf.math.is_nan(ref), axis=[-2, -1]))
    return tf.boolean_mask(x, keep, axis=0)
