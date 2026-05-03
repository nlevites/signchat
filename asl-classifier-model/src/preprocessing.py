"""Landmark preprocessing pipeline.

Mirrors the Kaggle ASL Fingerspelling 1st-place recipe:
  1. Drop frames where both hands are fully NaN.
  2. Handedness canonicalize: if left hand has fewer NaNs, mirror x and swap.
  3. Subset to 130 landmarks (76 face + 12 pose + 42 hands).
  4. Per-clip mean/std normalize using non-NaN values; fallback mean=[0.5, 0.5, 0].
  5. Replace remaining NaN with 0.
  6. Resize temporally to a fixed length (default 384) and produce a mask.

We provide two implementations:
  - `preprocess_numpy(...)` for offline caching (used by record_clips and the
    WLASL extractor). Operates on full (T, 543, 3) arrays.
  - `Preprocess(tf.keras.layers.Layer)` so the same logic lives inside the
    SavedModel/TFLite graph at inference time.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

import numpy as np

from . import landmarks as lm

if TYPE_CHECKING:
    import tensorflow as tf  # only for type hints; real import is lazy below


def _nan_count(arr: np.ndarray) -> np.ndarray:
    return np.isnan(arr).any(axis=-1).sum(axis=-1)


def preprocess_numpy(holistic: np.ndarray, max_len: int = 384,
                     use_motion_deltas: bool = True,
                     use_acceleration: bool = False,
                     ) -> tuple[np.ndarray, np.ndarray]:
    """Run the full preprocessing pipeline on a single clip.

    Args:
        holistic: array of shape (T, 543, 3), x/y/z, NaN allowed.
        max_len: target temporal length.
        use_motion_deltas: if True, concatenate first-difference along time as
            channels 3..5 -> output channels = 6. Every Kaggle ASL Fingerspelling
            top-5 used motion features; we left them out originally as
            "premature complexity" and added them back in Phase 1.
        use_acceleration: if True (and use_motion_deltas), append second-
            difference along time as channels 6..8 -> output channels = 9.
            Required by 1st place asl-signs Kaggle solution (hoyso48 was
            explicit about "position + velocity + acceleration"). No-op
            unless use_motion_deltas is also True (acceleration is the
            derivative of velocity; computing without storing velocity
            would require a separate buffer).

    Returns:
        features: (max_len, 130, C) float32, no NaN.
                  C = 9 with deltas + accel, 6 with deltas only, 3 with neither.
        mask:     (max_len,) bool; True where a real frame exists.
    """
    if use_acceleration and not use_motion_deltas:
        raise ValueError("use_acceleration=True requires use_motion_deltas=True")
    if use_acceleration:
        n_ch = 9
    elif use_motion_deltas:
        n_ch = 6
    else:
        n_ch = 3
    if holistic.ndim != 3 or holistic.shape[1:] != (lm.N_TOTAL, 3):
        raise ValueError(f"expected (T, 543, 3); got {holistic.shape}")
    arr = holistic.astype(np.float32, copy=True)

    lhand = arr[:, lm.LHAND_OFFSET:lm.LHAND_OFFSET + lm.N_HAND]
    rhand = arr[:, lm.RHAND_OFFSET:lm.RHAND_OFFSET + lm.N_HAND]
    keep = ~(np.isnan(lhand).all(axis=(1, 2)) & np.isnan(rhand).all(axis=(1, 2)))
    if keep.any():
        arr = arr[keep]

    if arr.shape[0] == 0:
        feats = np.zeros((max_len, 130, n_ch), dtype=np.float32)
        mask = np.zeros((max_len,), dtype=bool)
        return feats, mask

    if _nan_count(arr[:, lm.LHAND_OFFSET:lm.LHAND_OFFSET + lm.N_HAND]) \
            .sum() < _nan_count(arr[:, lm.RHAND_OFFSET:lm.RHAND_OFFSET + lm.N_HAND]).sum():
        arr[..., 0] = -arr[..., 0]
        lhand_block = arr[:, lm.LHAND_OFFSET:lm.LHAND_OFFSET + lm.N_HAND].copy()
        rhand_block = arr[:, lm.RHAND_OFFSET:lm.RHAND_OFFSET + lm.N_HAND].copy()
        arr[:, lm.LHAND_OFFSET:lm.LHAND_OFFSET + lm.N_HAND] = rhand_block
        arr[:, lm.RHAND_OFFSET:lm.RHAND_OFFSET + lm.N_HAND] = lhand_block

    arr = arr[:, lm.SELECTED_COLUMNS]

    flat = arr.reshape(-1, 3)
    valid = ~np.isnan(flat).any(axis=-1)
    if valid.any():
        mean = np.nanmean(flat[valid], axis=0)
        std = np.nanstd(flat[valid], axis=0)
    else:
        mean = np.array([0.5, 0.5, 0.0], dtype=np.float32)
        std = np.array([1.0, 1.0, 1.0], dtype=np.float32)
    std = np.where(std < 1e-6, 1.0, std)
    arr = (arr - mean) / std
    arr = np.where(np.isnan(arr), 0.0, arr).astype(np.float32)

    t = arr.shape[0]
    if t == max_len:
        feats = arr
        mask = np.ones((max_len,), dtype=bool)
    elif t > max_len:
        idx = np.linspace(0, t - 1, max_len).round().astype(np.int64)
        feats = arr[idx]
        mask = np.ones((max_len,), dtype=bool)
    else:
        pad = np.zeros((max_len - t, 130, 3), dtype=np.float32)
        feats = np.concatenate([arr, pad], axis=0)
        mask = np.concatenate([np.ones(t, dtype=bool), np.zeros(max_len - t, dtype=bool)])

    if use_motion_deltas:
        # First-difference along time, padded with zeros for the first frame so
        # the channel count is uniform across the sequence. Computed AFTER
        # temporal resize so deltas reflect the same time grid the model sees.
        # Padding frames (mask==False) get delta=0 too, which is fine since the
        # model already ignores them via the attention/pool masks.
        deltas = np.zeros_like(feats)
        deltas[1:] = feats[1:] - feats[:-1]
        if use_acceleration:
            # Second-difference along time = derivative of velocity. Same
            # zero-pad-first-frame convention; channels 6..8 are accel_xyz.
            accel = np.zeros_like(deltas)
            accel[1:] = deltas[1:] - deltas[:-1]
            feats = np.concatenate([feats, deltas, accel], axis=-1).astype(np.float32, copy=False)
        else:
            feats = np.concatenate([feats, deltas], axis=-1).astype(np.float32, copy=False)

    return feats, mask


# Motion-energy gate for the realtime demo. Defined in src/contract.py to keep
# the state machine self-contained for tests; re-exported here so the demo
# imports it from the same module that owns the rest of the buffer-level
# helpers. Consumers should import either path indifferently.
try:
    from .contract import compute_motion_energy  # noqa: F401
except ImportError:
    # Fallback for legacy/standalone use; mirrors the contract.py implementation.
    RAW_LHAND_RANGE = (501, 522)
    RAW_RHAND_RANGE = (522, 543)
    PRE_LHAND_RANGE = (0, 21)
    PRE_RHAND_RANGE = (21, 42)

    def compute_motion_energy(buffer: np.ndarray, window: int = 30) -> float:  # type: ignore[no-redef]
        if buffer.ndim != 3:
            return 0.0
        L = buffer.shape[1]
        if L == 543:
            lh = buffer[:, RAW_LHAND_RANGE[0]:RAW_LHAND_RANGE[1], :3]
            rh = buffer[:, RAW_RHAND_RANGE[0]:RAW_RHAND_RANGE[1], :3]
        elif L >= 42:
            lh = buffer[:, PRE_LHAND_RANGE[0]:PRE_LHAND_RANGE[1], :3]
            rh = buffer[:, PRE_RHAND_RANGE[0]:PRE_RHAND_RANGE[1], :3]
        else:
            return 0.0
        hands = np.concatenate([lh, rh], axis=1)
        if hands.shape[0] > window:
            hands = hands[-window:]
        if hands.shape[0] < 2:
            return 0.0
        diffs = hands[1:] - hands[:-1]
        speeds = np.linalg.norm(diffs, axis=-1)
        if speeds.size == 0 or not np.any(np.isfinite(speeds)):
            return 0.0
        return float(np.nanmean(speeds))


def make_preprocess_layer(max_len: int = 384, use_motion_deltas: bool = True,
                          use_acceleration: bool = False):
    """Factory for the TF-graph version of `preprocess_numpy`.

    Returns a `tf.keras.layers.Layer` instance suitable for inclusion in a
    SavedModel. We import TensorFlow lazily so callers that only need the
    numpy path (offline cache extraction) don't pay the import cost.

    Train/serve parity matters: `use_motion_deltas` AND `use_acceleration`
    MUST match what `preprocess_numpy` was called with at cache-build time,
    otherwise the live demo feeds the wrong number of channels into the
    trained model.
    """
    import tensorflow as tf

    if use_acceleration and not use_motion_deltas:
        raise ValueError("use_acceleration=True requires use_motion_deltas=True")

    class Preprocess(tf.keras.layers.Layer):
        def __init__(self, max_len: int = 384, use_motion_deltas: bool = True,
                     use_acceleration: bool = False, **kwargs):
            super().__init__(**kwargs)
            self.max_len = max_len
            self.use_motion_deltas = use_motion_deltas
            self.use_acceleration = use_acceleration
            self.selected_cols = tf.constant(lm.SELECTED_COLUMNS, dtype=tf.int32)
            self.lhand_lo, self.lhand_hi = lm.LHAND_OFFSET, lm.LHAND_OFFSET + lm.N_HAND
            self.rhand_lo, self.rhand_hi = lm.RHAND_OFFSET, lm.RHAND_OFFSET + lm.N_HAND

        def call(self, holistic):
            x = tf.cast(holistic, tf.float32)

            lhand_nan = tf.reduce_all(tf.math.is_nan(x[:, self.lhand_lo:self.lhand_hi]), axis=[1, 2])
            rhand_nan = tf.reduce_all(tf.math.is_nan(x[:, self.rhand_lo:self.rhand_hi]), axis=[1, 2])
            keep = tf.logical_not(tf.logical_and(lhand_nan, rhand_nan))
            x = tf.boolean_mask(x, keep)

            n_left_nan = tf.reduce_sum(tf.cast(
                tf.reduce_any(tf.math.is_nan(x[:, self.lhand_lo:self.lhand_hi]), axis=-1), tf.int32))
            n_right_nan = tf.reduce_sum(tf.cast(
                tf.reduce_any(tf.math.is_nan(x[:, self.rhand_lo:self.rhand_hi]), axis=-1), tf.int32))
            flip = tf.less(n_left_nan, n_right_nan)

            def _do_flip():
                x_flipped = tf.concat([-x[..., :1], x[..., 1:]], axis=-1)
                l = x_flipped[:, self.lhand_lo:self.lhand_hi]
                r = x_flipped[:, self.rhand_lo:self.rhand_hi]
                head = x_flipped[:, :self.lhand_lo]
                return tf.concat([head, r, l], axis=1)

            x = tf.cond(flip, _do_flip, lambda: x)
            x = tf.gather(x, self.selected_cols, axis=1)

            flat = tf.reshape(x, (-1, 3))
            valid = tf.logical_not(tf.reduce_any(tf.math.is_nan(flat), axis=-1))
            valid_vals = tf.boolean_mask(flat, valid)

            def _stats():
                mean = tf.reduce_mean(valid_vals, axis=0)
                std = tf.math.reduce_std(valid_vals, axis=0)
                std = tf.where(std < 1e-6, tf.ones_like(std), std)
                return mean, std

            def _fallback():
                return (
                    tf.constant([0.5, 0.5, 0.0], dtype=tf.float32),
                    tf.constant([1.0, 1.0, 1.0], dtype=tf.float32),
                )

            mean, std = tf.cond(tf.size(valid_vals) > 0, _stats, _fallback)
            x = (x - mean) / std
            x = tf.where(tf.math.is_nan(x), tf.zeros_like(x), x)

            t = tf.shape(x)[0]
            feats, mask = tf.cond(
                t >= self.max_len,
                lambda: self._resize_down(x, t),
                lambda: self._pad(x, t),
            )
            if self.use_motion_deltas:
                deltas = feats[1:] - feats[:-1]
                first = tf.zeros_like(feats[:1])
                deltas = tf.concat([first, deltas], axis=0)
                if self.use_acceleration:
                    accel = deltas[1:] - deltas[:-1]
                    accel = tf.concat([first, accel], axis=0)
                    feats = tf.concat([feats, deltas, accel], axis=-1)
                else:
                    feats = tf.concat([feats, deltas], axis=-1)
            return feats, mask

        def _resize_down(self, x, t):
            idx = tf.cast(tf.linspace(0.0, tf.cast(t - 1, tf.float32), self.max_len), tf.int32)
            return tf.gather(x, idx, axis=0), tf.ones((self.max_len,), dtype=tf.bool)

        def _pad(self, x, t):
            pad = tf.zeros((self.max_len - t, 130, 3), dtype=tf.float32)
            feats = tf.concat([x, pad], axis=0)
            mask = tf.concat([tf.ones((t,), dtype=tf.bool), tf.zeros((self.max_len - t,), dtype=tf.bool)], axis=0)
            return feats, mask

        def get_config(self):
            return {
                **super().get_config(),
                "max_len": self.max_len,
                "use_motion_deltas": self.use_motion_deltas,
                "use_acceleration": self.use_acceleration,
            }

    return Preprocess(max_len=max_len, use_motion_deltas=use_motion_deltas,
                      use_acceleration=use_acceleration)
