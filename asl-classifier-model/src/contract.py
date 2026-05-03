"""Inference-time contract layer between the Conformer classifier and any
downstream live-streaming LLM consumer.

The classifier emits one set of class probabilities per inference tick (every
``inference_every`` webcam frames over the rolling 64-frame buffer). Without a
state machine in front of it, the LLM would see the same sign re-emitted 3-5
times as it passes through the buffer, with each emission carrying noisy
top-1 / top-K labels. This module solves three problems:

  1. **Per-tick event API** (``TickEvent``): top-K with calibrated
     probabilities + raw logits + an entropy-based uncertainty estimate +
     motion-energy. Stable JSON-serializable shape so the LLM client never has
     to parse model internals.

  2. **Stability + commit gating** (``ContractStateMachine``): emits exactly
     one ``committed=true`` event per actual sign, no matter how many windows
     the sign occupies. The commit fires on the rising edge of stability;
     subsequent windows of the same word are flagged ``stable=true`` but not
     re-committed until a release event (idle / low-confidence / different
     top-1) drops the suppression.

  3. **Motion-energy idle short-circuit**: cheap (~0.2 ms) gate that lets
     the realtime demo skip the model call entirely when the signer is
     between signs. Saves GPU and prevents the LLM from being spammed with
     low-confidence noise.

This module is pure-Python + numpy on purpose. No TensorFlow dependency so
unit tests, replay scripts, and the LLM bridge can import it without paying
for the TF graph initialization.
"""

from __future__ import annotations

import math
from collections import deque
from dataclasses import asdict, dataclass, field
from typing import Iterable

import numpy as np


# --------------------------------------------------------------------------- event

@dataclass
class TickEvent:
    """One inference tick's full state. Sent to the LLM bridge as JSON.

    All fields are JSON-serializable. ``top_k`` is a list of (word, prob, logit)
    tuples so the LLM can either threshold on prob or do log-likelihood scoring
    on the raw logits when composing sentence hypotheses. ``stability_count``
    is exposed so an LLM with its own commit policy can override ours.
    """
    t_ms: int
    window_id: int
    top_k: list[tuple[str, float, float]]
    max_prob: float
    entropy_nats: float
    motion_energy: float
    idle: bool
    low_conf: bool
    stable: bool
    committed: bool
    stability_count: int

    def to_dict(self) -> dict:
        d = asdict(self)
        # Tuples serialize as lists; that's fine for the LLM consumer.
        return d


def topk_from_probs(probs: np.ndarray, vocab: list[str], k: int,
                    logits: np.ndarray | None = None
                    ) -> list[tuple[str, float, float]]:
    """Select top-k (word, prob, logit) by probability.

    ``logits`` is optional (best-effort; if absent we record the log of the
    softmaxed prob, which is less informative but always available).
    """
    k = min(k, len(probs))
    idx = np.argsort(probs)[-k:][::-1]
    out: list[tuple[str, float, float]] = []
    for i in idx:
        i = int(i)
        word = vocab[i] if 0 <= i < len(vocab) else "<oov>"
        p = float(probs[i])
        if logits is not None:
            lg = float(logits[i])
        else:
            # Fallback: log of clipped prob. Useful only as a relative measure.
            lg = float(math.log(max(p, 1e-12)))
        out.append((word, p, lg))
    return out


def shannon_entropy_nats(probs: np.ndarray) -> float:
    """Shannon entropy in natural log units. Cheap; works on calibrated probs."""
    p = np.clip(probs, 1e-12, 1.0)
    return float(-np.sum(p * np.log(p)))


# --------------------------------------------------------------------------- motion energy

# Default landmark layout for the motion-energy helper. We accept either the
# 543-landmark raw Holistic buffer (pre-canonicalization) OR the 130-landmark
# preprocessed buffer; the helper detects the shape and selects hand indices
# accordingly. Hand-velocity is the right signal because it co-varies with
# signing activity but not with idle facial micro-movement.
RAW_LHAND_RANGE = (501, 522)   # MediaPipe Holistic offsets (see src/landmarks.py)
RAW_RHAND_RANGE = (522, 543)
PRE_LHAND_RANGE = (0, 21)      # post-preprocess subset layout (see src/landmarks.py)
PRE_RHAND_RANGE = (21, 42)


def compute_motion_energy(buffer: np.ndarray, window: int = 30) -> float:
    """Mean L2 frame-to-frame velocity of hand landmarks over the last `window` frames.

    Args:
        buffer: shape (T, L, C) where L is 543 (raw Holistic) or 130 (preprocessed).
            C is 3 (xyz) or higher; only the first 3 channels are used.
        window: how many trailing frames to average over.

    Returns:
        Scalar in normalized image-coordinate units. Roughly:
          - <0.005 idle / hands at rest
          - 0.01 - 0.05 typical signing
          - >0.10 fast or large arm motion
        These thresholds are empirical from the M4 webcam test rig; tune
        ``contract.motion_idle_thresh`` per camera setup.

    NaN handling: NaN frames (no hand detected by MediaPipe) are dropped before
    velocity computation. If fewer than 2 valid frames remain in the window,
    returns 0.0 (treated as idle).
    """
    if buffer.ndim != 3:
        return 0.0
    L = buffer.shape[1]
    if L == 543:
        lhand = buffer[:, RAW_LHAND_RANGE[0]:RAW_LHAND_RANGE[1], :3]
        rhand = buffer[:, RAW_RHAND_RANGE[0]:RAW_RHAND_RANGE[1], :3]
    elif L >= 42:
        lhand = buffer[:, PRE_LHAND_RANGE[0]:PRE_LHAND_RANGE[1], :3]
        rhand = buffer[:, PRE_RHAND_RANGE[0]:PRE_RHAND_RANGE[1], :3]
    else:
        return 0.0

    # Pick the most recent `window` frames.
    hands = np.concatenate([lhand, rhand], axis=1)        # (T, 42, 3)
    if hands.shape[0] > window:
        hands = hands[-window:]
    if hands.shape[0] < 2:
        return 0.0

    # Treat any frame with all-NaN hand keypoints as missing; for partial-NaN
    # frames, velocity contributions for the NaN landmarks are dropped via
    # nanmean.
    diffs = hands[1:] - hands[:-1]
    speeds = np.linalg.norm(diffs, axis=-1)               # (T-1, 42)
    if speeds.size == 0 or not np.any(np.isfinite(speeds)):
        return 0.0
    return float(np.nanmean(speeds))


# --------------------------------------------------------------------------- state machine

@dataclass
class ContractConfig:
    """All knobs for the state machine. Deserialize from contract.yaml."""
    k: int = 3
    oov_gate: float = 0.4
    stability_k: int = 3
    release_frames: int = 5
    release_prob: float = 0.3
    motion_idle_thresh: float = 0.05
    motion_window: int = 30


@dataclass
class _ReleaseTracker:
    """Counts consecutive ticks that look like release evidence."""
    idle_streak: int = 0
    low_conf_streak: int = 0

    def reset(self):
        self.idle_streak = 0
        self.low_conf_streak = 0


class ContractStateMachine:
    """Edge-triggered commit + release detection.

    Per-tick contract: caller passes raw probs + vocab + motion energy + a
    timestamp; the machine returns a ``TickEvent`` annotated with stability
    and commit flags.

    Commit policy:
      - A sign **commits** on the rising edge of stability: the first tick
        where ``stability_count >= stability_k`` AND the word is not
        currently suppressed.
      - After commit, the word is added to a single-slot suppression that
        persists until a **release**:
          (a) ``release_frames`` consecutive idle ticks, OR
          (b) ``release_frames`` consecutive ticks with
              ``max_prob < release_prob``, OR
          (c) the top-1 word changes to a different word with prob above
              ``oov_gate`` (immediate transition; no streak required).
      - Only one word in suppression at a time.

    Stability counter:
      - Increments while top-1 word matches the previous tick AND
        ``max_prob > oov_gate`` AND not idle.
      - Resets to 1 (this tick alone) on word change, low-conf, or idle.

    Idle short-circuit:
      - Caller is responsible for skipping the model when motion_energy is
        below threshold; if the model is skipped, caller passes
        ``probs=None`` and we synthesize an idle event with empty top_k.
    """

    def __init__(self, vocab: list[str], config: ContractConfig | None = None,
                 history_len: int = 64):
        self.vocab = list(vocab)
        self.config = config or ContractConfig()
        self.history_len = history_len

        self._tick_count = 0
        self._stability_count = 0
        self._last_top1: str | None = None
        self._suppressed_word: str | None = None
        self._release = _ReleaseTracker()
        self._committed_history: deque[TickEvent] = deque(maxlen=history_len)

    # --- introspection helpers ----------------------------------------------

    @property
    def committed_history(self) -> list[TickEvent]:
        """Recent committed events, oldest first."""
        return list(self._committed_history)

    @property
    def committed_words(self) -> list[str]:
        """Bare words from committed_history; convenient for the demo overlay."""
        return [e.top_k[0][0] for e in self._committed_history if e.top_k]

    def reset(self):
        """Reset all per-session state. Re-use ``self.vocab`` and ``self.config``."""
        self._tick_count = 0
        self._stability_count = 0
        self._last_top1 = None
        self._suppressed_word = None
        self._release.reset()
        self._committed_history.clear()

    # --- main entry point ---------------------------------------------------

    def update(self, *, t_ms: int, probs: np.ndarray | None,
               logits: np.ndarray | None = None,
               motion_energy: float = 0.0) -> TickEvent:
        """Advance the machine by one tick. Returns the annotated event.

        Pass ``probs=None`` to indicate the model was NOT called this tick
        (idle short-circuit). The event will have empty top_k, ``idle=True``,
        and contribute to the release counter.
        """
        cfg = self.config
        wid = self._tick_count
        self._tick_count += 1

        idle = motion_energy < cfg.motion_idle_thresh

        if probs is None or idle:
            # Model wasn't run this tick (or motion is below idle threshold);
            # emit a synthetic idle event.
            event = TickEvent(
                t_ms=int(t_ms), window_id=wid, top_k=[], max_prob=0.0,
                entropy_nats=0.0, motion_energy=float(motion_energy),
                idle=True, low_conf=True, stable=False, committed=False,
                stability_count=0,
            )
            self._note_release_candidate(event)
            return event

        topk = topk_from_probs(probs, self.vocab, cfg.k, logits=logits)
        max_prob = float(probs.max())
        entropy = shannon_entropy_nats(probs)
        top1 = topk[0][0] if topk else "<oov>"
        low_conf = max_prob < cfg.oov_gate

        # Stability counter
        if low_conf:
            self._stability_count = 0
        elif top1 == self._last_top1:
            self._stability_count += 1
        else:
            self._stability_count = 1
        self._last_top1 = None if low_conf else top1
        stable = (not low_conf) and (self._stability_count >= cfg.stability_k)

        # Commit policy: rising edge of stability AND not currently suppressed.
        committed = False
        if stable and top1 != self._suppressed_word:
            # Change-of-top-1 release: switching to a different confident word
            # immediately drops suppression on the previous one.
            if self._suppressed_word is not None and top1 != self._suppressed_word:
                self._suppressed_word = None
                self._release.reset()
            committed = True
            self._suppressed_word = top1
            self._release.reset()

        event = TickEvent(
            t_ms=int(t_ms), window_id=wid, top_k=topk,
            max_prob=max_prob, entropy_nats=entropy,
            motion_energy=float(motion_energy),
            idle=idle, low_conf=low_conf, stable=stable,
            committed=committed,
            stability_count=self._stability_count,
        )
        if committed:
            self._committed_history.append(event)
        self._note_release_candidate(event)
        return event

    # --- internal -----------------------------------------------------------

    def _note_release_candidate(self, event: TickEvent):
        """Update release streaks. Streaks are evaluated AFTER commit logic so
        a commit doesn't reset them prematurely."""
        cfg = self.config
        if self._suppressed_word is None:
            return  # nothing to release
        if event.idle:
            self._release.idle_streak += 1
        else:
            self._release.idle_streak = 0
        if event.low_conf or event.max_prob < cfg.release_prob:
            self._release.low_conf_streak += 1
        else:
            self._release.low_conf_streak = 0

        if (self._release.idle_streak >= cfg.release_frames
                or self._release.low_conf_streak >= cfg.release_frames):
            self._suppressed_word = None
            self._release.reset()


# --------------------------------------------------------------------------- helpers


def stream_committed_only(events: Iterable[TickEvent]) -> Iterable[TickEvent]:
    """Filter for ``committed=True`` only. Useful for offline replay scripts."""
    for e in events:
        if e.committed:
            yield e
