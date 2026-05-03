"""Model definitions.

Two architectures behind a `build_classifier(name, ...)` factory:
  - "mlp_stub":  flatten landmarks -> 1 Dense -> softmax. Vertical-slice baseline.
  - "conformer": small Conformer-style encoder + masked global average pool.

Both consume a (max_len, 130, 3) feature tensor + (max_len,) mask, and emit
softmax logits over `num_classes`.
"""

from __future__ import annotations

import tensorflow as tf
from tensorflow.keras import layers


class MaskedGlobalAveragePool1D(layers.Layer):
    def call(self, x: tf.Tensor, mask: tf.Tensor) -> tf.Tensor:
        m = tf.cast(mask, x.dtype)[..., tf.newaxis]                # (B, T, 1)
        s = tf.reduce_sum(x * m, axis=1)                           # (B, D)
        n = tf.reduce_sum(m, axis=1)                               # (B, 1)
        return s / tf.maximum(n, 1.0)


class PositionalEncoding(layers.Layer):
    def __init__(self, max_len: int, dim: int, **kwargs):
        super().__init__(**kwargs)
        pos = tf.cast(tf.range(max_len)[:, tf.newaxis], tf.float32)
        i = tf.cast(tf.range(dim)[tf.newaxis, :], tf.float32)
        angle = pos / tf.pow(10000.0, (2 * (i // 2)) / tf.cast(dim, tf.float32))
        pe = tf.where(tf.cast(i % 2, tf.bool), tf.cos(angle), tf.sin(angle))
        self.pe = tf.constant(pe[tf.newaxis, ...])                 # (1, T, D)

    def call(self, x: tf.Tensor) -> tf.Tensor:
        # Cast pe to x.dtype so the layer works under both fp32 and the
        # mixed_bfloat16 policy. self.pe is built in __init__ before the
        # global mixed_precision policy applies, so it stays fp32 regardless;
        # the input x is bf16 under the policy. Without this cast, AddV2
        # raises TypeError on dtype mismatch.
        return x + tf.cast(self.pe[:, :tf.shape(x)[1]], x.dtype)


class ConformerBlock(layers.Layer):
    """FFN/2 -> MHSA -> ConvModule -> FFN/2 -> LayerNorm.

    Lightweight reimpl. Conv module = pointwise -> GLU -> depthwise -> BN ->
    swish -> pointwise -> dropout. Half-residual on the FFN modules.
    """

    def __init__(self, dim: int, n_heads: int, conv_kernel: int,
                 ffn_expansion: int = 4, dropout: float = 0.2, **kwargs):
        super().__init__(**kwargs)
        self.dim = dim

        self.ffn1_norm = layers.LayerNormalization()
        self.ffn1_d1 = layers.Dense(dim * ffn_expansion, activation="swish")
        self.ffn1_drop1 = layers.Dropout(dropout)
        self.ffn1_d2 = layers.Dense(dim)
        self.ffn1_drop2 = layers.Dropout(dropout)

        self.attn_norm = layers.LayerNormalization()
        self.attn = layers.MultiHeadAttention(num_heads=n_heads, key_dim=dim // n_heads, dropout=dropout)
        self.attn_drop = layers.Dropout(dropout)

        self.conv_norm = layers.LayerNormalization()
        self.conv_pw1 = layers.Dense(dim * 2)
        self.conv_dw = layers.DepthwiseConv1D(kernel_size=conv_kernel, padding="same")
        self.conv_bn = layers.BatchNormalization()
        self.conv_pw2 = layers.Dense(dim)
        self.conv_drop = layers.Dropout(dropout)

        self.ffn2_norm = layers.LayerNormalization()
        self.ffn2_d1 = layers.Dense(dim * ffn_expansion, activation="swish")
        self.ffn2_drop1 = layers.Dropout(dropout)
        self.ffn2_d2 = layers.Dense(dim)
        self.ffn2_drop2 = layers.Dropout(dropout)

        self.final_norm = layers.LayerNormalization()

    def _ffn(self, x, norm, d1, drop1, d2, drop2):
        h = norm(x)
        h = drop1(d1(h))
        h = drop2(d2(h))
        return x + 0.5 * h

    def _conv(self, x):
        h = self.conv_norm(x)
        h = self.conv_pw1(h)
        a, b = tf.split(h, 2, axis=-1)
        h = a * tf.sigmoid(b)                                      # GLU
        h = self.conv_dw(h)
        h = self.conv_bn(h)
        h = tf.nn.swish(h)
        h = self.conv_pw2(h)
        h = self.conv_drop(h)
        return x + h

    def call(self, x: tf.Tensor, mask: tf.Tensor | None = None) -> tf.Tensor:
        x = self._ffn(x, self.ffn1_norm, self.ffn1_d1, self.ffn1_drop1, self.ffn1_d2, self.ffn1_drop2)

        attn_in = self.attn_norm(x)
        if mask is not None:
            kp = tf.cast(mask, tf.bool)[:, tf.newaxis, tf.newaxis, :]   # (B,1,1,T)
            attn_out = self.attn(attn_in, attn_in, attention_mask=kp)
        else:
            attn_out = self.attn(attn_in, attn_in)
        x = x + self.attn_drop(attn_out)

        x = self._conv(x)
        x = self._ffn(x, self.ffn2_norm, self.ffn2_d1, self.ffn2_drop1, self.ffn2_d2, self.ffn2_drop2)
        return self.final_norm(x)


def _build_mlp_stub(num_classes: int, max_len: int, n_landmarks: int,
                    n_channels: int, dim: int, dropout: float):
    feats_in = layers.Input(shape=(max_len, n_landmarks, n_channels), name="features")
    mask_in = layers.Input(shape=(max_len,), name="mask", dtype=tf.bool)

    x = layers.Reshape((max_len, n_landmarks * n_channels))(feats_in)
    x = layers.Dense(dim, activation="relu")(x)
    x = MaskedGlobalAveragePool1D()(x, mask=mask_in)
    if dropout > 0:
        x = layers.Dropout(dropout)(x)
    # Force fp32 logits even when the global mixed_precision policy is bf16.
    # Industry standard for from-scratch transformer/Conformer training: the
    # final softmax benefits from full precision while upstream layers run
    # bf16 for throughput. Negligible cost (one final matmul out of dozens).
    logits = layers.Dense(num_classes, dtype="float32")(x)
    return tf.keras.Model([feats_in, mask_in], logits, name="mlp_stub")


def _build_conformer(num_classes: int, max_len: int, n_landmarks: int, n_channels: int,
                     dim: int, n_blocks: int, n_heads: int, conv_kernel: int,
                     ffn_expansion: int, dropout: float):
    feats_in = layers.Input(shape=(max_len, n_landmarks, n_channels), name="features")
    mask_in = layers.Input(shape=(max_len,), name="mask", dtype=tf.bool)

    x = layers.Reshape((max_len, n_landmarks * n_channels))(feats_in)
    x = layers.Dense(dim)(x)
    x = PositionalEncoding(max_len, dim)(x)

    for _ in range(n_blocks):
        x = ConformerBlock(dim, n_heads, conv_kernel, ffn_expansion, dropout)(x, mask=mask_in)

    x = MaskedGlobalAveragePool1D()(x, mask=mask_in)
    x = layers.Dropout(dropout)(x)
    # See _build_mlp_stub: final Dense in fp32 to keep logit precision under
    # the global mixed_bfloat16 policy.
    logits = layers.Dense(num_classes, dtype="float32")(x)
    return tf.keras.Model([feats_in, mask_in], logits, name="conformer")


def build_classifier(num_classes: int, *, name: str = "conformer", max_len: int = 384,
                     n_landmarks: int = 130, n_channels: int = 6, dim: int = 192,
                     n_blocks: int = 4, n_heads: int = 4, conv_kernel: int = 17,
                     ffn_expansion: int = 4, dropout: float = 0.2) -> tf.keras.Model:
    """Build the classifier.

    `n_channels` defaults to 6 to match the Phase 1 config (xyz + xyz_velocity).
    Pass 3 to build a model compatible with pre-Phase-1 weights (xyz only); the
    Reshape -> Dense flow handles either width transparently, so the only
    parameter shape change is the very first Dense's input dimension.
    """
    if name == "mlp_stub":
        return _build_mlp_stub(num_classes, max_len, n_landmarks, n_channels, dim, dropout)
    if name == "conformer":
        return _build_conformer(num_classes, max_len, n_landmarks, n_channels, dim,
                                n_blocks, n_heads, conv_kernel, ffn_expansion, dropout)
    raise ValueError(f"unknown model name: {name!r}")
