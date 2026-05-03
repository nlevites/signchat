"""tf.data-friendly augmentations for landmark sequences.

All ops act on (max_len, 130, C) feature tensors (C = 3 for xyz only, or 6
for xyz + xyz_velocity per Phase 1's motion-delta channels) that have
already been preprocessed (mean=0, std=1, NaN replaced by 0).

Inspired by the 1st-place Kaggle ASL Fingerspelling cfg_2 augmentation list:
SpatialAffine, TimeResample, TemporalMask, FingerDrop, sequence CutMix.
Apache-2.0-compatible reimplementations.

Channel-count handling:
- spatial_affine reshapes to (-1, 3) and applies a 3D rotation to each
  3-vector. For 6-channel input, channels (0,1,2) are xyz and (3,4,5) are
  xyz_velocity; both are 3D vectors and SHOULD rotate together (velocity
  rotates the same as the position it's the derivative of), so the
  reshape semantics are correct. The shift adds to ALL 3-vectors which
  technically applies a translation to the velocity component too; that's
  a tiny semantic wart but empirically harmless.
- time_resample / temporal_mask / finger_drop / cutmix preserve the
  channel dim explicitly via tf.shape(features)[-1].
"""

from __future__ import annotations

import tensorflow as tf

from . import landmarks as lm


def spatial_affine(features: tf.Tensor,
                   max_rot_deg: float = 15.0,
                   max_scale: float = 0.1,
                   max_shift: float = 0.1) -> tf.Tensor:
    """Apply random rotation around z, scale, and translation in the xy plane."""
    theta = tf.random.uniform([], -max_rot_deg, max_rot_deg) * (3.14159265 / 180.0)
    scale = 1.0 + tf.random.uniform([], -max_scale, max_scale)
    shift_x = tf.random.uniform([], -max_shift, max_shift)
    shift_y = tf.random.uniform([], -max_shift, max_shift)

    cos_t = tf.cos(theta)
    sin_t = tf.sin(theta)
    rot = tf.stack([
        tf.stack([cos_t, -sin_t, 0.0]),
        tf.stack([sin_t,  cos_t, 0.0]),
        tf.stack([  0.0,    0.0, 1.0]),
    ])

    flat = tf.reshape(features, [-1, 3])
    flat = tf.matmul(flat, rot, transpose_b=True) * scale
    flat = flat + tf.stack([shift_x, shift_y, 0.0])
    return tf.reshape(flat, tf.shape(features))


def time_resample(features: tf.Tensor,
                  mask: tf.Tensor,
                  min_ratio: float = 0.8,
                  max_ratio: float = 1.2) -> tuple[tf.Tensor, tf.Tensor]:
    """Stretch / compress along time, then re-pad to original length."""
    max_len = tf.shape(features)[0]
    n_lm = tf.shape(features)[1]
    n_ch = tf.shape(features)[2]
    real_len = tf.reduce_sum(tf.cast(mask, tf.int32))
    ratio = tf.random.uniform([], min_ratio, max_ratio)
    new_len = tf.cast(tf.round(tf.cast(real_len, tf.float32) * ratio), tf.int32)
    new_len = tf.clip_by_value(new_len, 8, max_len)

    valid = features[:real_len]
    valid = tf.transpose(valid, [1, 2, 0])                             # (n_lm, n_ch, real_len)
    valid = tf.expand_dims(valid, axis=-1)                             # (n_lm, n_ch, real_len, 1)
    resized = tf.image.resize(valid, [n_ch, new_len])                  # (n_lm, n_ch, new_len, 1)
    resized = tf.squeeze(resized, axis=-1)
    resized = tf.transpose(resized, [2, 0, 1])                         # (new_len, n_lm, n_ch)

    pad = tf.zeros([max_len - new_len, n_lm, n_ch], dtype=features.dtype)
    new_feats = tf.concat([resized, pad], axis=0)
    # Restore the static shape so downstream layers see (max_len, n_lm, n_ch)
    # rather than (None, None, None) — without this, dynamic-shape ops upstream
    # collapse the static shape and the model rejects the input.
    new_feats.set_shape(features.shape)
    new_mask = tf.concat([
        tf.ones([new_len], dtype=tf.bool),
        tf.zeros([max_len - new_len], dtype=tf.bool),
    ], axis=0)
    new_mask.set_shape(mask.shape)
    return new_feats, new_mask


def temporal_mask(features: tf.Tensor,
                  max_mask_frames: int = 32,
                  n_masks: int = 2) -> tf.Tensor:
    """SpecAugment-style temporal masking: zero out random time spans."""
    max_len = tf.shape(features)[0]
    out = features

    def _one_mask(x):
        width = tf.random.uniform([], 1, max_mask_frames + 1, dtype=tf.int32)
        start = tf.random.uniform([], 0, tf.maximum(1, max_len - width), dtype=tf.int32)
        idx = tf.range(max_len)
        keep = tf.logical_or(idx < start, idx >= start + width)
        keep = tf.reshape(tf.cast(keep, x.dtype), [max_len, 1, 1])
        return x * keep

    for _ in range(n_masks):
        out = _one_mask(out)
    return out


def finger_drop(features: tf.Tensor, prob: float = 0.1) -> tf.Tensor:
    """Independently zero out left or right hand block with probability `prob`."""
    drop_l = tf.random.uniform([]) < prob
    drop_r = tf.random.uniform([]) < prob

    mask = tf.ones([130, 1], dtype=features.dtype)
    if_drop_l = tf.tensor_scatter_nd_update(
        mask, tf.reshape(tf.range(0, 21), [-1, 1]), tf.zeros([21, 1], dtype=features.dtype))
    mask = tf.cond(drop_l, lambda: if_drop_l, lambda: mask)

    if_drop_r = tf.tensor_scatter_nd_update(
        mask, tf.reshape(tf.range(21, 42), [-1, 1]), tf.zeros([21, 1], dtype=features.dtype))
    mask = tf.cond(drop_r, lambda: if_drop_r, lambda: mask)

    return features * mask[tf.newaxis, :, :]


def cutmix_sequence(features_a: tf.Tensor, mask_a: tf.Tensor, label_a: tf.Tensor,
                    features_b: tf.Tensor, mask_b: tf.Tensor, label_b: tf.Tensor,
                    alpha: float = 0.5) -> tuple[tf.Tensor, tf.Tensor, tf.Tensor]:
    """Splice the first `r * len_a` frames of A with the last `(1-r) * len_b` of B."""
    max_len = tf.shape(features_a)[0]
    r = tf.cast(tf.random.uniform([], alpha, 1.0 - alpha), tf.float32)

    real_a = tf.reduce_sum(tf.cast(mask_a, tf.int32))
    cut_a = tf.cast(tf.cast(real_a, tf.float32) * r, tf.int32)

    real_b = tf.reduce_sum(tf.cast(mask_b, tf.int32))
    keep_b = tf.minimum(real_b, max_len - cut_a)

    head = features_a[:cut_a]
    tail = features_b[:keep_b]
    n_lm = tf.shape(features_a)[1]
    n_ch = tf.shape(features_a)[2]
    pad = tf.zeros([max_len - cut_a - keep_b, n_lm, n_ch], dtype=features_a.dtype)
    feats = tf.concat([head, tail, pad], axis=0)
    feats.set_shape(features_a.shape)

    new_real = cut_a + keep_b
    new_mask = tf.concat([
        tf.ones([new_real], dtype=tf.bool),
        tf.zeros([max_len - new_real], dtype=tf.bool),
    ], axis=0)

    mix_label = r * tf.cast(label_a, tf.float32) + (1.0 - r) * tf.cast(label_b, tf.float32)
    return feats, new_mask, mix_label


def build_augment_fn(cfg: dict):
    """Compose augmentations into a single (features, mask) -> (features, mask) callable.

    Per-element augmentations only. CutMix runs at the BATCH level via
    ``build_batch_cutmix``; it has its own pipeline stage in
    ``src/data/tfrecords.py`` because it needs pairs.
    """
    sa = cfg.get("spatial_affine", {})
    tr = cfg.get("time_resample", {})
    tm = cfg.get("temporal_mask", {})
    fd = cfg.get("finger_drop", {})

    def _fn(features: tf.Tensor, mask: tf.Tensor):
        if tr.get("enabled"):
            features, mask = time_resample(features, mask,
                                           min_ratio=tr.get("min_ratio", 0.8),
                                           max_ratio=tr.get("max_ratio", 1.2))
        if sa.get("enabled"):
            features = spatial_affine(features,
                                      max_rot_deg=sa.get("max_rot_deg", 15.0),
                                      max_scale=sa.get("max_scale", 0.1),
                                      max_shift=sa.get("max_shift", 0.1))
        if tm.get("enabled"):
            features = temporal_mask(features,
                                     max_mask_frames=tm.get("max_mask_frames", 32),
                                     n_masks=tm.get("n_masks", 2))
        if fd.get("enabled"):
            features = finger_drop(features, prob=fd.get("prob", 0.1))
        return features, mask

    return _fn


def build_batch_cutmix(alpha: float = 0.3, prob: float = 1.0):
    """Batch-level CutMix wrapping ``cutmix_sequence`` over a shuffled pairing.

    Expects ALREADY one-hot (or soft) labels of shape (B, num_classes). Pairs
    each example in the batch with another via ``tf.random.shuffle`` of the
    indices, then applies ``cutmix_sequence`` per-pair via ``tf.map_fn``.
    Returns a callable suitable for ``tf.data.Dataset.map`` after ``.batch()``:

        ((feats_b, mask_b), labels_oh) -> ((feats_b, mask_b), labels_oh_mixed)

    The 2nd-place asl-signs Kaggle solution (Toporov) flagged CutMix as their
    strongest single augmentation; 1st-place asl-fingerspelling top-5 all used
    it too. Per ``cutmix_sequence`` semantics: ``r`` is sampled in
    ``[alpha, 1-alpha]`` and a fraction ``r`` of A's frames is concatenated
    with ``(1-r)`` of B's; soft labels are blended by the same ratio.

    Args:
        alpha: lower bound on the mixing ratio. Default 0.3 -> r in [0.3, 0.7].
            Avoid alpha=0.5 (degenerates to a constant r=0.5).
        prob: per-batch probability of applying CutMix at all (vs identity).
            Default 1.0 = always mix when this stage is in the pipeline.
    """

    def _fn(xs, labels_oh):
        feats, mask = xs

        def _do():
            B = tf.shape(feats)[0]
            perm = tf.random.shuffle(tf.range(B))
            feats_p = tf.gather(feats, perm)
            mask_p = tf.gather(mask, perm)
            labels_p = tf.gather(labels_oh, perm)

            def _per_item(args):
                fa, ma, la, fb, mb, lb = args
                return cutmix_sequence(fa, ma, la, fb, mb, lb, alpha=alpha)

            out = tf.map_fn(
                _per_item,
                (feats, mask, labels_oh, feats_p, mask_p, labels_p),
                fn_output_signature=(
                    tf.TensorSpec(shape=feats.shape[1:], dtype=feats.dtype),
                    tf.TensorSpec(shape=mask.shape[1:], dtype=mask.dtype),
                    tf.TensorSpec(shape=labels_oh.shape[1:], dtype=labels_oh.dtype),
                ),
            )
            return out

        do_mix = tf.random.uniform([]) < prob
        feats_out, mask_out, labels_out = tf.cond(
            do_mix,
            _do,
            lambda: (feats, mask, labels_oh),
        )
        return (feats_out, mask_out), labels_out

    return _fn
