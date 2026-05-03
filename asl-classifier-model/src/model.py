"""Hoyso48's 1st-place asl-signs architecture.

Faithful port of cells 14-16 of the reference notebook:
    https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution/blob/main/ISLR_1st_place_Hoyeol_Sohn.ipynb

Architecture (~1-2M params):

    Input (B, max_len, CHANNELS)             # CHANNELS = 6 * NUM_NODES = 708
      -> Masking(mask_value=PAD=-100)
      -> Dense(dim) + BN                     # stem
      -> Conv1DBlock(dim, ksize=17) x 3
      -> TransformerBlock(dim, expand=2) x 1
      -> Conv1DBlock(dim, ksize=17) x 3
      -> TransformerBlock(dim, expand=2) x 1
      -> Dense(dim * 2)                      # top_conv
      -> GlobalAveragePooling1D
      -> LateDropout(0.8, start_step=...)
      -> Dense(num_classes)                  # logits, fp32

    `dim=192` is the canonical setting; `dim=384` doubles the depth.

Conv1DBlock(channels, ksize, expand=2, drop_rate=0.2):
    Dense(channels * expand, swish)          # pointwise expand
    -> CausalDWConv1D(ksize)                 # depthwise temporal conv
    -> BatchNorm(momentum=0.95)
    -> ECA(kernel=5)                         # Efficient Channel Attention
    -> Dense(channels)                       # pointwise project
    -> Dropout(0.2, noise_shape=(None,1,1))  # DropConnect-style channel drop
    -> add skip if channels match

TransformerBlock(dim, expand=2, drop=0.2):
    BN -> MHSA(dim, heads=4, attn_drop=0.2) -> Dropout(0.2,(None,1,1)) -> Add
    BN -> Dense(2*dim, swish) -> Dense(dim) -> Dropout(0.2,(None,1,1)) -> Add
"""

from __future__ import annotations

import tensorflow as tf

from .preprocessing import PAD


# --------------------------------------------------------------------------- ECA

class ECA(tf.keras.layers.Layer):
    """Efficient Channel Attention (Wang et al. 2020).

    Cheap drop-in attention module: mask-aware GAP -> 1D conv on channel axis
    -> sigmoid -> per-channel rescale.
    """

    def __init__(self, kernel_size: int = 5, **kwargs):
        super().__init__(**kwargs)
        self.supports_masking = True
        self.kernel_size = kernel_size
        self.conv = tf.keras.layers.Conv1D(
            1, kernel_size=kernel_size, strides=1, padding="same", use_bias=False,
        )

    def call(self, inputs, mask=None):
        nn = tf.keras.layers.GlobalAveragePooling1D()(inputs, mask=mask)
        nn = tf.expand_dims(nn, -1)
        nn = self.conv(nn)
        nn = tf.squeeze(nn, -1)
        nn = tf.nn.sigmoid(nn)
        nn = nn[:, None, :]
        return inputs * nn


# --------------------------------------------------------------------------- LateDropout

class LateDropout(tf.keras.layers.Layer):
    """Dropout that's identity until `start_step`, then activates with `rate`.

    Used by hoyso48 as an aggressive 80% dropout before the classifier; kicks
    in at epoch 15 so the encoder has time to converge first.
    """

    def __init__(self, rate: float, noise_shape=None, start_step: int = 0, **kwargs):
        super().__init__(**kwargs)
        self.supports_masking = True
        self.rate = rate
        self.start_step = start_step
        self.dropout = tf.keras.layers.Dropout(rate, noise_shape=noise_shape)

    def build(self, input_shape):
        super().build(input_shape)
        agg = tf.VariableAggregation.ONLY_FIRST_REPLICA
        self._train_counter = tf.Variable(0, dtype="int64", aggregation=agg, trainable=False)

    def call(self, inputs, training: bool = False):
        x = tf.cond(
            self._train_counter < self.start_step,
            lambda: inputs,
            lambda: self.dropout(inputs, training=training),
        )
        if training:
            self._train_counter.assign_add(1)
        return x


# --------------------------------------------------------------------------- causal depthwise conv

class CausalDWConv1D(tf.keras.layers.Layer):
    """Depthwise 1D conv with causal (left-only) padding."""

    def __init__(self, kernel_size: int = 17, dilation_rate: int = 1,
                 use_bias: bool = False, depthwise_initializer: str = "glorot_uniform",
                 name: str = "", **kwargs):
        super().__init__(name=name, **kwargs)
        self.causal_pad = tf.keras.layers.ZeroPadding1D(
            (dilation_rate * (kernel_size - 1), 0), name=name + "_pad",
        )
        self.dw_conv = tf.keras.layers.DepthwiseConv1D(
            kernel_size,
            strides=1,
            dilation_rate=dilation_rate,
            padding="valid",
            use_bias=use_bias,
            depthwise_initializer=depthwise_initializer,
            name=name + "_dwconv",
        )
        self.supports_masking = True

    def call(self, inputs):
        x = self.causal_pad(inputs)
        x = self.dw_conv(x)
        return x


# --------------------------------------------------------------------------- conv1d block

def Conv1DBlock(channel_size: int, kernel_size: int,
                dilation_rate: int = 1,
                drop_rate: float = 0.0,
                expand_ratio: int = 2,
                se_ratio: float = 0.25,
                activation: str = "swish",
                name: str | None = None):
    """Efficient inverted-residual conv block. From hoyso48."""
    if name is None:
        name = str(tf.keras.backend.get_uid("mbblock"))

    def apply(inputs):
        channels_in = tf.keras.backend.int_shape(inputs)[-1]
        channels_expand = channels_in * expand_ratio

        skip = inputs

        x = tf.keras.layers.Dense(
            channels_expand, use_bias=True, activation=activation,
            name=name + "_expand_conv",
        )(inputs)

        x = CausalDWConv1D(
            kernel_size, dilation_rate=dilation_rate, use_bias=False,
            name=name + "_dwconv",
        )(x)

        x = tf.keras.layers.BatchNormalization(momentum=0.95, name=name + "_bn")(x)

        x = ECA()(x)

        x = tf.keras.layers.Dense(
            channel_size, use_bias=True, name=name + "_project_conv",
        )(x)

        if drop_rate > 0:
            x = tf.keras.layers.Dropout(
                drop_rate, noise_shape=(None, 1, 1), name=name + "_drop",
            )(x)

        if channels_in == channel_size:
            x = tf.keras.layers.add([x, skip], name=name + "_add")
        return x

    return apply


# --------------------------------------------------------------------------- transformer block

class MultiHeadSelfAttention(tf.keras.layers.Layer):
    """Single-tensor MHSA with custom QKV projection (matches hoyso48 cell 15).

    Different from `tf.keras.layers.MultiHeadAttention` because (a) it supports
    keras masking through `self.supports_masking = True` and (b) it uses a
    single fused QKV Dense rather than three separate ones.
    """

    def __init__(self, dim: int = 256, num_heads: int = 4, dropout: float = 0.0, **kwargs):
        super().__init__(**kwargs)
        self.dim = dim
        self.scale = self.dim ** -0.5
        self.num_heads = num_heads
        self.qkv = tf.keras.layers.Dense(3 * dim, use_bias=False)
        self.drop1 = tf.keras.layers.Dropout(dropout)
        self.proj = tf.keras.layers.Dense(dim, use_bias=False)
        self.supports_masking = True

    def call(self, inputs, mask=None):
        qkv = self.qkv(inputs)
        qkv = tf.keras.layers.Permute((2, 1, 3))(
            tf.keras.layers.Reshape((-1, self.num_heads, self.dim * 3 // self.num_heads))(qkv)
        )
        q, k, v = tf.split(qkv, [self.dim // self.num_heads] * 3, axis=-1)

        attn = tf.matmul(q, k, transpose_b=True) * self.scale

        if mask is not None:
            mask = mask[:, None, None, :]

        attn = tf.keras.layers.Softmax(axis=-1)(attn, mask=mask)
        attn = self.drop1(attn)

        x = attn @ v
        x = tf.keras.layers.Reshape((-1, self.dim))(tf.keras.layers.Permute((2, 1, 3))(x))
        x = self.proj(x)
        return x


def TransformerBlock(dim: int = 256, num_heads: int = 4, expand: int = 4,
                     attn_dropout: float = 0.2, drop_rate: float = 0.2,
                     activation: str = "swish"):
    """Pre-norm transformer block: MHSA + FFN with residuals."""

    def apply(inputs):
        x = inputs
        x = tf.keras.layers.BatchNormalization(momentum=0.95)(x)
        x = MultiHeadSelfAttention(dim=dim, num_heads=num_heads, dropout=attn_dropout)(x)
        x = tf.keras.layers.Dropout(drop_rate, noise_shape=(None, 1, 1))(x)
        x = tf.keras.layers.Add()([inputs, x])
        attn_out = x

        x = tf.keras.layers.BatchNormalization(momentum=0.95)(x)
        x = tf.keras.layers.Dense(dim * expand, use_bias=False, activation=activation)(x)
        x = tf.keras.layers.Dense(dim, use_bias=False)(x)
        x = tf.keras.layers.Dropout(drop_rate, noise_shape=(None, 1, 1))(x)
        x = tf.keras.layers.Add()([attn_out, x])
        return x

    return apply


# --------------------------------------------------------------------------- top-level

def get_model(num_classes: int, *, max_len: int, channels: int,
              dim: int = 192, dropout_step: int = 0,
              kernel_size: int = 17,
              conv_drop: float = 0.2,
              transformer_expand: int = 2,
              late_drop: float = 0.8) -> tf.keras.Model:
    """Build the 1st-place asl-signs architecture.

    Layout for `dim=192` (~1.7M params):
        stem -> 3xConv1DBlock -> 1xTransformerBlock
             -> 3xConv1DBlock -> 1xTransformerBlock
             -> Dense(2*dim) -> GAP -> LateDropout -> Dense(num_classes)

    For `dim=384` we double the body to match hoyso48's "4x sized model" path.
    """
    inp = tf.keras.Input((max_len, channels))
    x = tf.keras.layers.Masking(mask_value=PAD, input_shape=(max_len, channels))(inp)

    x = tf.keras.layers.Dense(dim, use_bias=False, name="stem_conv")(x)
    x = tf.keras.layers.BatchNormalization(momentum=0.95, name="stem_bn")(x)

    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = TransformerBlock(dim, expand=transformer_expand)(x)

    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
    x = TransformerBlock(dim, expand=transformer_expand)(x)

    if dim == 384:  # hoyso48's "4x sized model" path
        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = TransformerBlock(dim, expand=transformer_expand)(x)

        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = Conv1DBlock(dim, kernel_size, drop_rate=conv_drop)(x)
        x = TransformerBlock(dim, expand=transformer_expand)(x)

    x = tf.keras.layers.Dense(dim * 2, activation=None, name="top_conv")(x)
    x = tf.keras.layers.GlobalAveragePooling1D()(x)
    x = LateDropout(late_drop, start_step=dropout_step)(x)
    # Force fp32 logits even when the global mixed_precision policy is bf16.
    logits = tf.keras.layers.Dense(num_classes, name="classifier", dtype="float32")(x)
    return tf.keras.Model(inp, logits, name="islr_hoyso48")
