"""Convert the pre-extracted MuteMotion WLASL dataset into our cache layout.

MuteMotion (https://www.kaggle.com/datasets/abd0kamel/mutemotion-output) ships:
  - WLASL_parsed_data.json: list of {gloss, video_path, frame_start, frame_end, split}
  - landmarks_V3.npz: keyed by video_id; each value is a (f, 553, 3) array
    laid out as [RHand(21), LHand(21), Pose(33), Face(478)] - the 478-point face
    mesh includes 10 iris landmarks at indices 468..477.

Our pipeline expects (T, 543, 3) arrays in [Pose(33), Face(468), LHand(21),
RHand(21)] order (see src/landmarks.py). This loader downloads MuteMotion via
kagglehub, permutes + slices to our layout, filters to the top-K most populous
glosses, and writes one .npy per clip into:

    data/cache/wlasl/wlasl_<split>/<gloss>/<video_id>.npy

It also writes data/cache/wlasl/vocab.json listing the chosen glosses in
canonical order so downstream configs can use `vocab: auto` (when the tfrecords
loader gains support) or copy them into the explicit vocab list.

Usage:
    python -m src.data.wlasl_kaggle_loader
    python -m src.data.wlasl_kaggle_loader --top-k 100 --limit-per-gloss 50

Requires Kaggle credentials at ~/.kaggle/kaggle.json (or the KAGGLE_USERNAME +
KAGGLE_KEY env vars). Get these from https://www.kaggle.com/settings -> "Create
New API Token".
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter
from pathlib import Path

import numpy as np
from tqdm import tqdm


N_RHAND = 21
N_LHAND = 21
N_POSE = 33
N_FACE_REFINED = 478          # MuteMotion's count (refined mesh w/ iris)
N_FACE_OURS = 468             # ours (no iris)
N_TOTAL_THEIRS = N_RHAND + N_LHAND + N_POSE + N_FACE_REFINED   # 553
N_TOTAL_OURS = N_POSE + N_FACE_OURS + N_LHAND + N_RHAND        # 543

KAGGLE_DATASET = "abd0kamel/mutemotion-output"


def _check_kaggle_credentials():
    """Raise SystemExit with a helpful message if Kaggle creds aren't set up."""
    has_file = (Path.home() / ".kaggle" / "kaggle.json").exists()
    has_env = os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY")
    if not (has_file or has_env):
        sys.exit(
            "ERROR: Kaggle credentials not found.\n"
            "  Option A: place kaggle.json at ~/.kaggle/kaggle.json (chmod 600).\n"
            "  Option B: set KAGGLE_USERNAME and KAGGLE_KEY env vars.\n"
            "Get a token at https://www.kaggle.com/settings -> 'Create New API Token'."
        )


def convert_553_to_543(arr: np.ndarray) -> np.ndarray:
    """Permute MuteMotion's (f, 553, 3) to our (f, 543, 3) layout.

    Their order:  [RHand(21), LHand(21), Pose(33), Face(478)]
    Our order:    [Pose(33),  Face(468), LHand(21), RHand(21)]
    Drops the 10 iris landmarks at face[468:478].
    """
    if arr.ndim != 3 or arr.shape[1] != N_TOTAL_THEIRS or arr.shape[2] != 3:
        raise ValueError(f"expected (f, {N_TOTAL_THEIRS}, 3); got {arr.shape}")
    rhand = arr[:, 0:N_RHAND]
    lhand = arr[:, N_RHAND:N_RHAND + N_LHAND]
    pose = arr[:, N_RHAND + N_LHAND:N_RHAND + N_LHAND + N_POSE]
    face_full = arr[:, N_RHAND + N_LHAND + N_POSE:]
    face = face_full[:, :N_FACE_OURS]                              # iris dropped
    out = np.concatenate([pose, face, lhand, rhand], axis=1)
    assert out.shape == (arr.shape[0], N_TOTAL_OURS, 3), out.shape
    return out.astype(np.float32, copy=False)


def _stem(path_or_id: str) -> str:
    """Get the bare video id from a path like 'videos/12345.mp4' or '12345'."""
    name = Path(path_or_id).name
    return name.rsplit(".", 1)[0]


def _resolve_landmarks(npz, video_id: str):
    """Look up an entry in landmarks_V3.npz robustly across naming conventions.

    MuteMotion's npz keys are stringified integers (``"0"``, ``"1"``, ...,
    ``"21082"``) corresponding to WLASL2000 video IDs WITHOUT leading zeros.
    The WLASL manifest, however, often uses zero-padded IDs like ``"07085"``
    in ``video_path``. Without stripping leading zeros we miss ~3K clips and
    ~1,600 glosses. Try the raw form first, then
    the stripped form, then the file-extension variants for robustness.
    """
    if video_id in npz:
        return npz[video_id]
    stripped = video_id.lstrip("0") or "0"  # "0" if all zeros
    if stripped != video_id and stripped in npz:
        return npz[stripped]
    for cand in (f"{video_id}.mp4", f"{video_id}.mkv", f"{video_id}.webm",
                 f"{stripped}.mp4", f"{stripped}.mkv", f"{stripped}.webm"):
        if cand in npz:
            return npz[cand]
    return None


def _slice_frames(arr: np.ndarray, frame_start, frame_end) -> np.ndarray:
    """Slice [frame_start-1 : frame_end] when both fields are usable."""
    t = arr.shape[0]
    if frame_start is None or frame_end is None:
        return arr
    fs = max(0, int(frame_start) - 1)
    fe = int(frame_end)
    if fe <= 0 or fe > t:
        fe = t
    if fs >= fe:
        return arr
    return arr[fs:fe]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--top-k", type=int, default=100,
                        help="keep the K most populous glosses (default: WLASL100)")
    parser.add_argument("--limit-per-gloss", type=int, default=None,
                        help="cap clips per gloss (use during smoke testing)")
    parser.add_argument("--out-dir", default="data/cache/wlasl",
                        help="where to write the converted cache")
    parser.add_argument("--dataset", default=KAGGLE_DATASET,
                        help="Kaggle dataset slug to download")
    args = parser.parse_args()

    _check_kaggle_credentials()

    try:
        import kagglehub
    except ImportError:
        sys.exit("ERROR: kagglehub not installed. Run `pip install kagglehub`.")

    print(f"[wlasl-kaggle] downloading {args.dataset}")
    src_dir = Path(kagglehub.dataset_download(args.dataset))
    print(f"[wlasl-kaggle] dataset at {src_dir}")

    json_path = next(src_dir.glob("**/WLASL_parsed_data.json"), None)
    npz_path = next(src_dir.glob("**/landmarks_V3.npz"), None)
    if json_path is None or npz_path is None:
        sys.exit(f"ERROR: expected WLASL_parsed_data.json + landmarks_V3.npz under {src_dir}")
    print(f"[wlasl-kaggle] manifest = {json_path.name}, landmarks = {npz_path.name}")

    with open(json_path) as f:
        manifest = json.load(f)
    print(f"[wlasl-kaggle] manifest entries: {len(manifest)}")

    npz = np.load(npz_path, allow_pickle=True)
    print(f"[wlasl-kaggle] landmarks_V3 keys: {len(npz.files)}")

    counts = Counter()
    for entry in manifest:
        gloss = entry.get("gloss")
        if not gloss:
            continue
        vid = _stem(entry.get("video_path", ""))
        if _resolve_landmarks(npz, vid) is not None:
            counts[gloss] += 1

    if not counts:
        sys.exit("ERROR: no manifest entries had matching landmarks; key format unexpected.")

    top = [g for g, _ in counts.most_common(args.top_k)]
    top_set = set(top)
    total_kept = sum(counts[g] for g in top)
    print(f"[wlasl-kaggle] selecting top {len(top)} glosses; "
          f"covering {total_kept} clips. Min/max per gloss: "
          f"{min(counts[g] for g in top)}/{max(counts[g] for g in top)}")

    out_root = Path(args.out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    with (out_root / "vocab.json").open("w") as f:
        json.dump({"vocab": top, "counts": {g: counts[g] for g in top}}, f, indent=2)
    print(f"[wlasl-kaggle] wrote {out_root / 'vocab.json'}")

    per_gloss_written = Counter()
    n_extracted = 0
    n_skipped_missing = 0
    n_skipped_short = 0
    for entry in tqdm(manifest, desc="convert"):
        gloss = entry.get("gloss")
        if gloss not in top_set:
            continue
        if args.limit_per_gloss and per_gloss_written[gloss] >= args.limit_per_gloss:
            continue
        vid = _stem(entry.get("video_path", ""))
        if not vid:
            continue
        raw = _resolve_landmarks(npz, vid)
        if raw is None:
            n_skipped_missing += 1
            continue
        sliced = _slice_frames(np.asarray(raw, dtype=np.float32),
                               entry.get("frame_start"), entry.get("frame_end"))
        if sliced.shape[0] < 4:
            n_skipped_short += 1
            continue
        try:
            converted = convert_553_to_543(sliced)
        except ValueError as e:
            print(f"[wlasl-kaggle] WARN skipping {vid}: {e}")
            continue
        split = str(entry.get("split", "train")).lower()
        signer_id = f"wlasl_{split}"
        out_path = out_root / signer_id / gloss / f"{vid}.npy"
        out_path.parent.mkdir(parents=True, exist_ok=True)
        np.save(out_path, converted)
        per_gloss_written[gloss] += 1
        n_extracted += 1

    print(f"\n[wlasl-kaggle] done: extracted={n_extracted} "
          f"skipped_missing_landmarks={n_skipped_missing} skipped_short={n_skipped_short}")
    print(f"[wlasl-kaggle] cache root: {out_root}")
    print("[wlasl-kaggle] split summary (clips per WLASL split):")
    by_split: dict[str, int] = {}
    for split_dir in sorted(out_root.iterdir()):
        if split_dir.is_dir() and split_dir.name.startswith("wlasl_"):
            n = sum(1 for _ in split_dir.glob("*/*.npy"))
            by_split[split_dir.name] = n
            print(f"  {split_dir.name:12s} {n}")


if __name__ == "__main__":
    main()
