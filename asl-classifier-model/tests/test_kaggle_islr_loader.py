"""Lightweight regression tests for the Kaggle ISLR (PopSign) loader.

Run:
    python -m unittest tests.test_kaggle_islr_loader

No TF, kagglehub, or large fixtures required: we synthesize a tiny parquet
in a temp dir and assert the on-disk pivot + Kaggle-sign -> disk-gloss map
behave correctly. These guard the two PopSign 250 correctness contracts:

  1. ``parquet_to_tensor`` produces (T, 543, 3) in our canonical
     [Pose, Face, LHand, RHand] order with NaNs preserved.
  2. ``kaggle_to_disk`` pairs each Kaggle string spelling with the disk
     gloss whose prediction index matches it -- regardless of the JSON
     insertion order of ``sign_to_prediction_index_map.json``.
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from src.data import kaggle_islr_loader as loader


def _write_long_parquet(path: Path, rows: list[dict]) -> None:
    df = pd.DataFrame(rows, columns=["frame", "type", "landmark_index", "x", "y", "z"])
    df.to_parquet(path)


class ParquetToTensorTest(unittest.TestCase):
    def test_shape_layout_and_offsets(self):
        with tempfile.TemporaryDirectory() as td:
            pq = Path(td) / "clip.parquet"
            rows = [
                {"frame": 0, "type": "pose",       "landmark_index": 0,  "x": 0.10, "y": 0.20, "z": 0.30},
                {"frame": 0, "type": "face",       "landmark_index": 5,  "x": 0.40, "y": 0.50, "z": 0.60},
                {"frame": 0, "type": "left_hand",  "landmark_index": 1,  "x": 0.70, "y": 0.80, "z": 0.90},
                {"frame": 0, "type": "right_hand", "landmark_index": 20, "x": 0.11, "y": 0.12, "z": 0.13},
                {"frame": 1, "type": "pose",       "landmark_index": 0,  "x": 0.21, "y": 0.22, "z": 0.23},
            ]
            _write_long_parquet(pq, rows)

            arr = loader.parquet_to_tensor(pq)
            self.assertEqual(arr.shape, (2, loader.N_TOTAL, 3))
            self.assertEqual(arr.dtype, np.float32)

            np.testing.assert_allclose(arr[0, loader.LOCAL_POSE_OFFSET + 0], [0.10, 0.20, 0.30])
            np.testing.assert_allclose(arr[0, loader.LOCAL_FACE_OFFSET + 5], [0.40, 0.50, 0.60])
            np.testing.assert_allclose(arr[0, loader.LOCAL_LHAND_OFFSET + 1], [0.70, 0.80, 0.90])
            np.testing.assert_allclose(arr[0, loader.LOCAL_RHAND_OFFSET + 20], [0.11, 0.12, 0.13])

            self.assertTrue(np.isnan(arr[0, loader.LOCAL_POSE_OFFSET + 1, 0]))
            self.assertTrue(np.isnan(arr[1, loader.LOCAL_FACE_OFFSET + 5, 0]))

    def test_empty_parquet_returns_one_nan_frame(self):
        with tempfile.TemporaryDirectory() as td:
            pq = Path(td) / "empty.parquet"
            _write_long_parquet(pq, [])
            arr = loader.parquet_to_tensor(pq)
            self.assertEqual(arr.shape, (1, loader.N_TOTAL, 3))
            self.assertTrue(np.isnan(arr).all())

    def test_sparse_frame_indices_compact(self):
        with tempfile.TemporaryDirectory() as td:
            pq = Path(td) / "clip.parquet"
            rows = [
                {"frame": 0,  "type": "pose", "landmark_index": 0, "x": 0.1, "y": 0.1, "z": 0.1},
                {"frame": 7,  "type": "pose", "landmark_index": 0, "x": 0.2, "y": 0.2, "z": 0.2},
                {"frame": 13, "type": "pose", "landmark_index": 0, "x": 0.3, "y": 0.3, "z": 0.3},
            ]
            _write_long_parquet(pq, rows)

            arr = loader.parquet_to_tensor(pq)
            self.assertEqual(arr.shape, (3, loader.N_TOTAL, 3))
            np.testing.assert_allclose(arr[0, loader.LOCAL_POSE_OFFSET + 0], [0.1, 0.1, 0.1])
            np.testing.assert_allclose(arr[1, loader.LOCAL_POSE_OFFSET + 0], [0.2, 0.2, 0.2])
            np.testing.assert_allclose(arr[2, loader.LOCAL_POSE_OFFSET + 0], [0.3, 0.3, 0.3])


class VocabAliasMapTest(unittest.TestCase):
    def test_kaggle_to_disk_uses_prediction_index_not_dict_order(self):
        # Insertion order intentionally NOT sorted by index. The map must
        # still pair each Kaggle string with the disk gloss whose
        # prediction index matches it.
        sign_to_idx = {
            "milk": 2,
            "after": 0,
            "thank you": 1,
        }
        vocab, _aliases = loader._vocab_with_aliases(sign_to_idx)

        signs_by_index = sorted(sign_to_idx, key=lambda s: sign_to_idx[s])
        kaggle_to_disk = {orig: vocab[i] for i, orig in enumerate(signs_by_index)}

        from src.data.gloss_aliases import expand_aliases

        for sign, disk in kaggle_to_disk.items():
            forms = expand_aliases(sign)
            self.assertIn(disk, forms,
                          f"disk gloss {disk!r} for sign {sign!r} not in alias list {forms!r}")

        self.assertEqual(len(kaggle_to_disk), len(sign_to_idx))
        self.assertEqual(set(kaggle_to_disk.values()), set(vocab))


if __name__ == "__main__":
    unittest.main()
