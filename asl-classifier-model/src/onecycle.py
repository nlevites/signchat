"""OneCycleLR schedule.

Vendored from hoyso48's tf-utils (https://github.com/hoyso48/tf-utils,
Apache-2.0). Used by the 1st-place asl-signs solution. Inlined here so the
pod doesn't need to install a private git dependency at provisioning time.

Original author: Hoyeol Sohn <hoeyol0730@gmail.com>, 2022.
"""

from __future__ import annotations

import math

import tensorflow as tf


class OneCycleLR(tf.keras.optimizers.schedules.LearningRateSchedule):
    """Single-cycle warmup -> sustain -> decay schedule.

    Mirrors the schedule used in the 1st-place asl-signs notebook, where the
    SAME instance is also passed as `weight_decay` to RectifiedAdam (so wd
    follows the LR shape in absolute scale).

    Args mirror hoyso48's signature exactly.
    """

    def __init__(self,
                 lr: float = 1e-4,
                 epochs: int = 10,
                 steps_per_epoch: int = 100,
                 steps_per_update: int = 1,
                 resume_epoch: int = 0,
                 decay_epochs: int = 10,
                 sustain_epochs: int = 0,
                 warmup_epochs: int = 0,
                 lr_start: float = 0,
                 lr_min: float = 0,
                 warmup_type: str = "linear",
                 decay_type: str = "cosine",
                 **kwargs):
        super().__init__(**kwargs)
        self.lr = float(lr)
        self.epochs = float(epochs)
        self.steps_per_update = float(steps_per_update)
        self.resume_epoch = float(resume_epoch)
        self.steps_per_epoch = float(steps_per_epoch)
        self.decay_epochs = float(decay_epochs)
        self.sustain_epochs = float(sustain_epochs)
        self.warmup_epochs = float(warmup_epochs)
        self.lr_start = float(lr_start)
        self.lr_min = float(lr_min)
        self.decay_type = decay_type
        self.warmup_type = warmup_type

    def __call__(self, step):
        step = tf.cast(step, tf.float32)
        warmup_steps = self.warmup_epochs * self.steps_per_epoch
        sustain_steps = self.sustain_epochs * self.steps_per_epoch
        decay_steps = self.decay_epochs * self.steps_per_epoch

        if self.resume_epoch > 0:
            step = step + self.resume_epoch * self.steps_per_epoch

        step = tf.cond(step > decay_steps, lambda: decay_steps, lambda: step)
        step = tf.math.truediv(step, self.steps_per_update) * self.steps_per_update

        warmup_cond = step < warmup_steps
        decay_cond = step >= (warmup_steps + sustain_steps)

        if self.warmup_type == "linear":
            lr = tf.cond(
                warmup_cond,
                lambda: tf.math.divide_no_nan(self.lr - self.lr_start, warmup_steps) * step + self.lr_start,
                lambda: self.lr,
            )
        elif self.warmup_type == "exponential":
            factor = tf.pow(self.lr_start, 1.0 / warmup_steps)
            lr = tf.cond(
                warmup_cond,
                lambda: (self.lr - self.lr_start) * factor ** (warmup_steps - step) + self.lr_start,
                lambda: self.lr,
            )
        elif self.warmup_type == "cosine":
            lr = tf.cond(
                warmup_cond,
                lambda: 0.5 * (self.lr - self.lr_start)
                * (1 + tf.cos(math.pi * (warmup_steps - step) / warmup_steps))
                + self.lr_start,
                lambda: self.lr,
            )
        else:
            raise NotImplementedError(f"unknown warmup_type: {self.warmup_type!r}")

        if self.decay_type == "linear":
            lr = tf.cond(
                decay_cond,
                lambda: self.lr + (self.lr_min - self.lr) / (decay_steps - warmup_steps - sustain_steps)
                * (step - warmup_steps - sustain_steps),
                lambda: lr,
            )
        elif self.decay_type == "exponential":
            factor = tf.pow(self.lr_min, 1.0 / (decay_steps - warmup_steps - sustain_steps))
            lr = tf.cond(
                decay_cond,
                lambda: (self.lr - self.lr_min) * factor ** (step - warmup_steps - sustain_steps) + self.lr_min,
                lambda: lr,
            )
        elif self.decay_type == "cosine":
            lr = tf.cond(
                decay_cond,
                lambda: 0.5 * (self.lr - self.lr_min)
                * (1 + tf.cos(math.pi * (step - warmup_steps - sustain_steps) / (decay_steps - warmup_steps - sustain_steps)))
                + self.lr_min,
                lambda: lr,
            )
        else:
            raise NotImplementedError(f"unknown decay_type: {self.decay_type!r}")

        return lr

    def get_config(self):
        return {
            "lr": self.lr,
            "epochs": self.epochs,
            "steps_per_epoch": self.steps_per_epoch,
            "steps_per_update": self.steps_per_update,
            "resume_epoch": self.resume_epoch,
            "decay_epochs": self.decay_epochs,
            "sustain_epochs": self.sustain_epochs,
            "warmup_epochs": self.warmup_epochs,
            "lr_start": self.lr_start,
            "lr_min": self.lr_min,
            "warmup_type": self.warmup_type,
            "decay_type": self.decay_type,
        }
