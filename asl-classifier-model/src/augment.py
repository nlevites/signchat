"""Augmentations for the hoyso48 1st-place port.

Faithful port of cell 8 of the reference notebook:
    https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution/blob/main/ISLR_1st_place_Hoyeol_Sohn.ipynb

All augmentations operate on raw (T, 543, 3) MediaPipe Holistic landmarks in
our LOCAL [Pose, Face, LHand, RHand] cache layout. They run inside the
tf.data graph (no python in the inner loop) so input pipeline overhead stays
flat across the 4-hour H200 train.

Suite (in `augment_fn`):

    | Aug                  | p    | Range                                        |
    |---                   |---   |---                                           |
    | resample (time)      | 0.8  | (0.5, 1.5) -- WIDER than the typical 0.8-1.2 |
    | flip_lr (mirror x)   | 0.5  | -- swap LHAND/RHAND, LLIP/RLIP, etc          |
    | temporal_crop        | 1.0  | crop to max_len                              |
    | spatial_random_affine| 0.75 | scale +-0.2, shear +-0.15, shift +-0.1, rot +-30 deg |
    | temporal_mask (NaN)  | 0.5  | 20-40% of T                                  |
    | spatial_mask (NaN)   | 0.5  | 20-40% bbox                                  |

Note: NO CutMix, NO MixUp, NO finger_drop. Hoyso48's submission doesn't use them.
"""

from __future__ import annotations

import math

import numpy as np
import tensorflow as tf

from .landmarks import (
    LEYE,
    LHAND,
    LLIP,
    LNOSE,
    LPOSE,
    N_TOTAL,
    REYE,
    RHAND,
    RLIP,
    RNOSE,
    RPOSE,
)


# --------------------------------------------------------------------------- time

def interp1d_(x: tf.Tensor, target_len: tf.Tensor, method: str = "random") -> tf.Tensor:
    """Time-axis interpolation. `random` mode samples from {bilinear, bicubic, nearest}."""
    target_len = tf.maximum(1, target_len)
    if method == "random":
        if tf.random.uniform(()) < 0.33:
            x = tf.image.resize(x, (target_len, tf.shape(x)[1]), "bilinear")
        else:
            if tf.random.uniform(()) < 0.5:
                x = tf.image.resize(x, (target_len, tf.shape(x)[1]), "bicubic")
            else:
                x = tf.image.resize(x, (target_len, tf.shape(x)[1]), "nearest")
    else:
        x = tf.image.resize(x, (target_len, tf.shape(x)[1]), method)
    return x


def resample(x: tf.Tensor, rate=(0.8, 1.2)) -> tf.Tensor:
    """Random time-axis stretch by a factor in `rate`."""
    rate = tf.random.uniform((), rate[0], rate[1])
    length = tf.shape(x)[0]
    new_size = tf.cast(rate * tf.cast(length, tf.float32), tf.int32)
    return interp1d_(x, new_size)


def temporal_crop(x: tf.Tensor, length: int) -> tf.Tensor:
    """Random temporal crop to `length`. If T <= length, returns x unchanged."""
    l = tf.shape(x)[0]
    offset = tf.random.uniform(
        (), 0, tf.clip_by_value(l - length, 1, length), dtype=tf.int32,
    )
    return x[offset: offset + length]


def temporal_mask(x: tf.Tensor, size=(0.2, 0.4),
                  mask_value: float = float("nan")) -> tf.Tensor:
    """Mask a contiguous chunk of frames (set to NaN by default)."""
    l = tf.shape(x)[0]
    mask_size = tf.random.uniform((), *size)
    mask_size = tf.cast(tf.cast(l, tf.float32) * mask_size, tf.int32)
    mask_offset = tf.random.uniform(
        (), 0, tf.clip_by_value(l - mask_size, 1, l), dtype=tf.int32,
    )
    indices = tf.range(mask_offset, mask_offset + mask_size)[..., None]
    updates = tf.fill([mask_size, N_TOTAL, 3], mask_value)
    return tf.tensor_scatter_nd_update(x, indices, updates)


# --------------------------------------------------------------------------- spatial

def spatial_random_affine(xyz: tf.Tensor,
                          scale=(0.8, 1.2),
                          shear=(-0.15, 0.15),
                          shift=(-0.1, 0.1),
                          degree=(-30, 30)) -> tf.Tensor:
    """Random affine on the (x, y) plane: scale, shear, rotation, translation.

    z is preserved through scale/shift but excluded from shear/rotation since
    those operate in the image plane only.
    """
    center = tf.constant([0.5, 0.5])
    if scale is not None:
        s = tf.random.uniform((), *scale)
        xyz = s * xyz

    if shear is not None:
        xy = xyz[..., :2]
        z = xyz[..., 2:]
        shear_x = shear_y = tf.random.uniform((), *shear)
        if tf.random.uniform(()) < 0.5:
            shear_x = 0.0
        else:
            shear_y = 0.0
        shear_mat = tf.identity([
            [1.0, shear_x],
            [shear_y, 1.0],
        ])
        xy = xy @ shear_mat
        center = center + [shear_y, shear_x]
        xyz = tf.concat([xy, z], axis=-1)

    if degree is not None:
        xy = xyz[..., :2]
        z = xyz[..., 2:]
        xy = xy - center
        deg = tf.random.uniform((), *degree)
        radian = deg / 180.0 * math.pi
        c = tf.math.cos(radian)
        s = tf.math.sin(radian)
        rotate_mat = tf.identity([[c, s], [-s, c]])
        xy = xy @ rotate_mat
        xy = xy + center
        xyz = tf.concat([xy, z], axis=-1)

    if shift is not None:
        d = tf.random.uniform((), *shift)
        xyz = xyz + d

    return xyz


def spatial_mask(x: tf.Tensor, size=(0.2, 0.4),
                 mask_value: float = float("nan")) -> tf.Tensor:
    """Mask any landmark whose (x, y) falls inside a random axis-aligned bbox."""
    mask_offset_y = tf.random.uniform(())
    mask_offset_x = tf.random.uniform(())
    mask_size = tf.random.uniform((), *size)
    mask_x = (mask_offset_x < x[..., 0]) & (x[..., 0] < mask_offset_x + mask_size)
    mask_y = (mask_offset_y < x[..., 1]) & (x[..., 1] < mask_offset_y + mask_size)
    mask = mask_x & mask_y
    return tf.where(mask[..., None], mask_value, x)


# --------------------------------------------------------------------------- flip

def _swap_blocks(x: tf.Tensor, a_idx: list[int], b_idx: list[int]) -> tf.Tensor:
    """Swap the two blocks of landmarks identified by `a_idx` and `b_idx`."""
    a = tf.gather(x, a_idx, axis=0)
    b = tf.gather(x, b_idx, axis=0)
    x = tf.tensor_scatter_nd_update(x, tf.constant(a_idx)[..., None], b)
    x = tf.tensor_scatter_nd_update(x, tf.constant(b_idx)[..., None], a)
    return x


def flip_lr(x: tf.Tensor) -> tf.Tensor:
    """Mirror x-coordinate and swap left/right anatomical blocks.

    Faithful port of cell 8 of the reference notebook. Operates on raw
    (T, 543, 3); after the flip the data still represents valid right/left
    orientation because we swap block memberships.
    """
    x_, y_, z_ = tf.unstack(x, axis=-1)
    x_ = 1.0 - x_
    new_x = tf.stack([x_, y_, z_], axis=-1)
    # Transpose to (landmarks, T, 3) so per-landmark gather/scatter is along axis 0.
    new_x = tf.transpose(new_x, [1, 0, 2])

    new_x = _swap_blocks(new_x, LHAND, RHAND)
    new_x = _swap_blocks(new_x, LLIP, RLIP)
    new_x = _swap_blocks(new_x, LPOSE, RPOSE)
    new_x = _swap_blocks(new_x, LEYE, REYE)
    new_x = _swap_blocks(new_x, LNOSE, RNOSE)

    new_x = tf.transpose(new_x, [1, 0, 2])
    return new_x


# --------------------------------------------------------------------------- top-level

def augment_fn(x: tf.Tensor, always: bool = False, max_len: int | None = None) -> tf.Tensor:
    """Apply the full augmentation suite to (T, 543, 3) raw landmarks.

    `always=True` forces every aug to fire; used for visualization/testing.
    `max_len`, when set, drives the `temporal_crop` step.
    """
    if tf.random.uniform(()) < 0.8 or always:
        x = resample(x, (0.5, 1.5))
    if tf.random.uniform(()) < 0.5 or always:
        x = flip_lr(x)
    if max_len is not None:
        x = temporal_crop(x, max_len)
    if tf.random.uniform(()) < 0.75 or always:
        x = spatial_random_affine(x)
    if tf.random.uniform(()) < 0.5 or always:
        x = temporal_mask(x)
    if tf.random.uniform(()) < 0.5 or always:
        x = spatial_mask(x)
    return x
