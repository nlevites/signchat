"""Synthetic-stream replay tests for src.contract.ContractStateMachine.

Run:
    python -m unittest tests.test_contract
or:
    pytest tests/test_contract.py        (if pytest is installed)

These tests verify the state machine's commit policy without involving any
TF/MediaPipe/webcam stack — pure numpy + the dataclass.
"""

from __future__ import annotations

import unittest

import numpy as np

from src.contract import (
    ContractConfig,
    ContractStateMachine,
    TickEvent,
    compute_motion_energy,
    shannon_entropy_nats,
    topk_from_probs,
)


VOCAB = ["MILK", "COFFEE", "DRINK", "PLEASE", "THANKS"]


def _probs_for(top_word: str, top_p: float) -> np.ndarray:
    """Build a synthetic probability vector with `top_word` at `top_p` and the
    rest splitting the remainder uniformly."""
    p = np.full(len(VOCAB), (1.0 - top_p) / (len(VOCAB) - 1), dtype=np.float32)
    p[VOCAB.index(top_word)] = top_p
    return p


class TopKHelpersTest(unittest.TestCase):
    def test_topk_orders_by_prob(self):
        probs = np.array([0.1, 0.4, 0.3, 0.05, 0.15])
        out = topk_from_probs(probs, VOCAB, k=3)
        self.assertEqual([w for (w, _, _) in out], ["COFFEE", "DRINK", "THANKS"])

    def test_topk_caps_at_vocab_len(self):
        probs = np.array([0.5, 0.5])
        out = topk_from_probs(probs, ["A", "B"], k=10)
        self.assertEqual(len(out), 2)

    def test_entropy_uniform_is_log_n(self):
        probs = np.full(5, 0.2, dtype=np.float32)
        self.assertAlmostEqual(shannon_entropy_nats(probs), float(np.log(5)),
                               places=5)

    def test_entropy_concentrated_is_zero_ish(self):
        probs = np.array([0.999, 0.0001, 0.0003, 0.0003, 0.0003], dtype=np.float32)
        self.assertLess(shannon_entropy_nats(probs), 0.05)


class MotionEnergyTest(unittest.TestCase):
    def _moving_buffer(self, n_frames: int, n_landmarks: int,
                        speed: float) -> np.ndarray:
        """A synthetic buffer where each frame moves all landmarks by `speed`."""
        buf = np.zeros((n_frames, n_landmarks, 3), dtype=np.float32)
        for t in range(n_frames):
            buf[t] = t * speed
        return buf

    def test_motion_zero_when_static(self):
        buf = np.zeros((30, 543, 3), dtype=np.float32)
        self.assertAlmostEqual(compute_motion_energy(buf), 0.0)

    def test_motion_increases_with_speed(self):
        slow = self._moving_buffer(30, 543, speed=0.001)
        fast = self._moving_buffer(30, 543, speed=0.05)
        self.assertGreater(compute_motion_energy(fast),
                           compute_motion_energy(slow))

    def test_motion_handles_subset_layout(self):
        """130-landmark preprocessed buffer should also work."""
        buf = self._moving_buffer(30, 130, speed=0.01)
        # Should compute over hands (idx 0..42) successfully.
        e = compute_motion_energy(buf)
        self.assertGreater(e, 0.0)


class ContractStateMachineTest(unittest.TestCase):

    def setUp(self):
        self.cfg = ContractConfig(
            k=3, oov_gate=0.4, stability_k=3,
            release_frames=3, release_prob=0.3,
            motion_idle_thresh=0.05,
        )
        self.sm = ContractStateMachine(VOCAB, self.cfg)

    # --- single-sign commit ------------------------------------------------

    def test_one_sign_commits_exactly_once(self):
        """8 ticks of the same confident top-1 → exactly one committed event
        (on tick index stability_k - 1 = 2, since stability is 1-indexed)."""
        events: list[TickEvent] = []
        for i in range(8):
            ev = self.sm.update(
                t_ms=i * 100,
                probs=_probs_for("MILK", 0.8),
                motion_energy=0.20,
            )
            events.append(ev)
        committed_idxs = [i for i, e in enumerate(events) if e.committed]
        self.assertEqual(committed_idxs, [2],
                         f"expected single commit at index 2; got {committed_idxs}")
        self.assertEqual(events[2].top_k[0][0], "MILK")
        self.assertGreaterEqual(events[2].max_prob, 0.7)
        # All later same-word ticks: stable=True but committed=False (suppressed).
        for i in range(3, 8):
            self.assertTrue(events[i].stable, f"tick {i} should be stable")
            self.assertFalse(events[i].committed,
                             f"tick {i} should be suppressed")

    # --- two signs separated by idle --------------------------------------

    def test_two_signs_separated_by_idle(self):
        """10 ticks MILK → 5 ticks idle → 8 ticks COFFEE → expect two
        committed events for MILK and COFFEE (one each)."""
        events: list[TickEvent] = []
        # MILK
        for i in range(10):
            events.append(self.sm.update(
                t_ms=i * 100,
                probs=_probs_for("MILK", 0.8),
                motion_energy=0.20,
            ))
        # idle (probs=None to simulate model-skipped tick)
        for i in range(10, 15):
            events.append(self.sm.update(
                t_ms=i * 100,
                probs=None,
                motion_energy=0.0,
            ))
        # COFFEE
        for i in range(15, 23):
            events.append(self.sm.update(
                t_ms=i * 100,
                probs=_probs_for("COFFEE", 0.85),
                motion_energy=0.20,
            ))
        committed = [(i, e.top_k[0][0]) for i, e in enumerate(events) if e.committed]
        words = [w for _, w in committed]
        self.assertEqual(words, ["MILK", "COFFEE"],
                         f"expected [MILK, COFFEE]; got {committed}")
        # MILK commits at tick 2, COFFEE commits ~ at tick 17 (= 15 + stability_k - 1).
        self.assertEqual(committed[0][0], 2)
        self.assertEqual(committed[1][0], 17)

    # --- low-confidence resets stability ----------------------------------

    def test_low_conf_resets_stability(self):
        """A flicker below oov_gate breaks the stability streak."""
        # Two confident MILK
        self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        self.sm.update(t_ms=100, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        # Low-conf interruption
        ev_low = self.sm.update(t_ms=200,
                                 probs=_probs_for("MILK", 0.30),
                                 motion_energy=0.2)
        self.assertTrue(ev_low.low_conf)
        self.assertFalse(ev_low.stable)
        # Two confident MILK again — should NOT commit yet (need stability_k=3
        # consecutive confident ticks, and we just had only 2).
        ev1 = self.sm.update(t_ms=300, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        ev2 = self.sm.update(t_ms=400, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        self.assertFalse(ev1.committed)
        self.assertFalse(ev2.committed)
        # Third confident tick after the reset → commits
        ev3 = self.sm.update(t_ms=500, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        self.assertTrue(ev3.committed)

    # --- top-1 change triggers immediate re-commit eligibility ------------

    def test_top1_change_releases_suppression(self):
        """After committing MILK, switching confident top-1 to COFFEE should
        commit COFFEE on its 3rd consecutive confident tick (no need to wait
        for an idle release)."""
        for _ in range(5):
            self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        # Now switch to COFFEE
        events = []
        for i in range(5):
            events.append(self.sm.update(
                t_ms=1000 + i * 100,
                probs=_probs_for("COFFEE", 0.9),
                motion_energy=0.2,
            ))
        committed_words = [e.top_k[0][0] for e in events if e.committed]
        self.assertEqual(committed_words, ["COFFEE"])

    # --- motion idle short-circuit ----------------------------------------

    def test_motion_idle_overrides_probs(self):
        """If motion_energy < threshold, the event is forced idle even with
        confident probs (caller should normally also pass probs=None, but
        defense in depth)."""
        ev = self.sm.update(
            t_ms=0,
            probs=_probs_for("MILK", 0.95),
            motion_energy=0.001,  # below threshold
        )
        self.assertTrue(ev.idle)
        self.assertFalse(ev.stable)
        self.assertEqual(ev.top_k, [])

    # --- committed_history accumulates ------------------------------------

    def test_committed_history_accumulates(self):
        # MILK
        for _ in range(4):
            self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        # idle release
        for _ in range(5):
            self.sm.update(t_ms=0, probs=None, motion_energy=0.0)
        # COFFEE
        for _ in range(4):
            self.sm.update(t_ms=0, probs=_probs_for("COFFEE", 0.85), motion_energy=0.2)
        self.assertEqual(self.sm.committed_words, ["MILK", "COFFEE"])

    # --- reset clears state -----------------------------------------------

    def test_reset(self):
        for _ in range(4):
            self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        self.assertEqual(len(self.sm.committed_history), 1)
        self.sm.reset()
        self.assertEqual(self.sm.committed_history, [])
        # Fresh stability counter: needs stability_k confident ticks to commit again.
        e1 = self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        e2 = self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        e3 = self.sm.update(t_ms=0, probs=_probs_for("MILK", 0.8), motion_energy=0.2)
        self.assertFalse(e1.committed)
        self.assertFalse(e2.committed)
        self.assertTrue(e3.committed)


class TickEventSerializationTest(unittest.TestCase):
    def test_to_dict_is_jsonable(self):
        import json
        sm = ContractStateMachine(VOCAB, ContractConfig())
        ev = sm.update(t_ms=42,
                        probs=_probs_for("MILK", 0.8),
                        motion_energy=0.2)
        s = json.dumps(ev.to_dict())
        parsed = json.loads(s)
        self.assertEqual(parsed["t_ms"], 42)
        self.assertIn("top_k", parsed)
        self.assertIn("committed", parsed)


if __name__ == "__main__":
    unittest.main()
