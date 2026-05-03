"""Adversarial Weight Perturbation (AWP) wrapper.

Vendored from hoyso48's tf-utils (https://github.com/hoyso48/tf-utils,
Apache-2.0). Used by the 1st-place asl-signs solution. The trick: at every
train step starting from `start_step`, do (1) forward+backward to get the
gradient, (2) perturb the trainable weights along the L2-normalized gradient
direction with magnitude `delta`, (3) forward+backward again on the perturbed
weights to get the adversarial gradient, (4) restore the original weights and
apply the adversarial gradient. Effectively a smoothness regularizer at ~2x
per-step cost.

Original author: Hoyeol Sohn <hoeyol0730@gmail.com>, 2022.
"""

from __future__ import annotations

import tensorflow as tf


class AWP(tf.keras.Model):
    """A `tf.keras.Model` subclass that overrides `train_step` to do AWP.

    Construct as `AWP(inputs, outputs, delta=0.2, eps=0.0, start_step=...)`.
    Compile/fit normally; once `self._train_counter >= start_step`, the AWP
    train step kicks in.
    """

    def __init__(self, *args, delta: float = 0.1, eps: float = 1e-4,
                 start_step: int = 0, **kwargs):
        super().__init__(*args, **kwargs)
        self.delta = delta
        self.eps = eps
        self.start_step = start_step

    def train_step_awp(self, data):
        x, y = data

        with tf.GradientTape() as tape:
            y_pred = self(x, training=True)
            loss = self.compiled_loss(y, y_pred, regularization_losses=self.losses)

        params = self.trainable_variables
        params_gradients = tape.gradient(loss, self.trainable_variables)

        # Step 1: perturb weights along normalized gradient direction.
        for i in range(len(params_gradients)):
            grad = tf.zeros_like(params[i]) + params_gradients[i]
            delta = tf.math.divide_no_nan(
                self.delta * grad,
                tf.math.sqrt(tf.reduce_sum(grad ** 2)) + self.eps,
            )
            self.trainable_variables[i].assign_add(delta)

        # Step 2: forward+backward on the perturbed weights.
        with tf.GradientTape() as tape2:
            y_pred = self(x, training=True)
            new_loss = self.compiled_loss(y, y_pred, regularization_losses=self.losses)
            if hasattr(self.optimizer, "get_scaled_loss"):
                new_loss = self.optimizer.get_scaled_loss(new_loss)

        gradients = tape2.gradient(new_loss, self.trainable_variables)
        if hasattr(self.optimizer, "get_unscaled_gradients"):
            gradients = self.optimizer.get_unscaled_gradients(gradients)

        # Step 3: restore weights.
        for i in range(len(params_gradients)):
            grad = tf.zeros_like(params[i]) + params_gradients[i]
            delta = tf.math.divide_no_nan(
                self.delta * grad,
                tf.math.sqrt(tf.reduce_sum(grad ** 2)) + self.eps,
            )
            self.trainable_variables[i].assign_sub(delta)

        # Step 4: apply adversarial gradient.
        self.optimizer.apply_gradients(zip(gradients, self.trainable_variables))
        self.compiled_metrics.update_state(y, y_pred)
        return {m.name: m.result() for m in self.metrics}

    def train_step(self, data):
        return tf.cond(
            self._train_counter < self.start_step,
            lambda: super(AWP, self).train_step(data),
            lambda: self.train_step_awp(data),
        )
