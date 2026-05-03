"""Convert the Google Kaggle Isolated Sign Language Recognition (asl-signs)
dataset into our (T, 543, 3) cache layout.

Competition: https://www.kaggle.com/competitions/asl-signs
Backing dataset: PopSign ASL v1.0 (NeurIPS 2023). 250 isolated signs,
~95K reviewed sequences from ~21 Deaf participants on Pixel 4A selfies. Already
shipped as MediaPipe Holistic landmarks (no video extraction step).

Data layout (post-download):
    train.csv                                 # (path, participant_id, sequence_id, sign)
    sign_to_prediction_index_map.json         # {sign: int}
    train_landmark_files/<participant>/<sequence>.parquet

Each parquet is the long-format landmarks for ONE sequence:
    frame, row_id, type, landmark_index, x, y, z

`type` is one of {"face", "left_hand", "pose", "right_hand"}, with counts
(468, 21, 33, 21) -> 543 per frame. Coordinates are MediaPipe-normalized
(x, y in [0, 1]; z is depth in image-width units, sign-flipped to be smaller =
closer to camera). Missing landmarks (no detection) are NaN, matching our
preprocessing convention.

This loader:
  1. Downloads via kagglehub.competition_download("asl-signs") OR uses
     ``--source-dir`` for an already-extracted copy on a RunPod volume.
  2. For each row in train.csv, reads the parquet, pivots to (T, 543, 3) in
     OUR canonical [Pose(33), Face(468), LHand(21), RHand(21)] order.
  3. Writes one .npy per clip into:
        data/cache/kaggle_islr/kaggle_<safe_pid>/<safe_gloss>/<sequence>.npy
     The ``kaggle_<pid>`` signer-id prefix matches the per-participant layout
     used by ASL Citizen v2; lets ``data/splits/kaggle_islr.json`` carve a
     signer-disjoint train/val/test by listing explicit signer ids.
  4. Writes ``data/cache/kaggle_islr/vocab.json`` (the 250 PopSign signs
     unioned/aliased to ASL Citizen + WLASL conventions via the existing
     gloss alias resolver) so ``vocab: auto`` in any pretrain config picks
     up the new classes without manual edits.
  5. Validates schema on a sample of clips when ``--validate-schema`` is
     passed: shape == (T, 543, 3), x/y in [0, 1], NaN frequency per part is
     in expected band. Catches MediaPipe-version drift early before any pod
     spend.

Usage:
    python -m src.data.kaggle_islr_loader --validate-schema
    python -m src.data.kaggle_islr_loader --workers 8
    python -m src.data.kaggle_islr_loader --source-dir /workspace/datasets/asl-signs

Requires Kaggle credentials at ~/.kaggle/kaggle.json (or KAGGLE_USERNAME +
KAGGLE_KEY env vars). The asl-signs *competition* requires that you have
accepted the competition rules on the Kaggle web UI before the download
endpoint will return data.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import numpy as np
import pandas as pd
from tqdm import tqdm


KAGGLE_COMPETITION = "asl-signs"

# Kaggle ISLR per-frame landmark counts. Total = 543 = local N_TOTAL.
N_FACE = 468
N_LHAND = 21
N_POSE = 33
N_RHAND = 21
N_TOTAL = N_FACE + N_LHAND + N_POSE + N_RHAND  # 543

# Local order is [Pose, Face, LHand, RHand] (see src/landmarks.py).
LOCAL_POSE_OFFSET = 0
LOCAL_FACE_OFFSET = N_POSE
LOCAL_LHAND_OFFSET = N_POSE + N_FACE
LOCAL_RHAND_OFFSET = N_POSE + N_FACE + N_LHAND

# Validate-schema: per-part NaN frequency we expect to see in valid frames.
# A clip with substantially HIGHER face NaN than this hints at a different
# MediaPipe version (refine_face_landmarks=True vs False, etc.).
NAN_BAND = {
    "face": (0.0, 0.30),
    "left_hand": (0.05, 0.95),   # one-handed bias means lhand is often missing
    "pose": (0.0, 0.30),
    "right_hand": (0.0, 0.95),
}


# --------------------------------------------------------------------------- credentials

def _check_kaggle_credentials():
    has_file = (Path.home() / ".kaggle" / "kaggle.json").exists()
    has_env = os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY")
    if not (has_file or has_env):
        sys.exit(
            "ERROR: Kaggle credentials not found.\n"
            "  Option A: place kaggle.json at ~/.kaggle/kaggle.json (chmod 600).\n"
            "  Option B: set KAGGLE_USERNAME and KAGGLE_KEY env vars.\n"
            "Get a token at https://www.kaggle.com/settings -> 'Create New API Token'.\n"
            "Then ACCEPT the competition rules at "
            "https://www.kaggle.com/competitions/asl-signs/rules - the download "
            "endpoint silently 403s for unaccepted competitions."
        )


# --------------------------------------------------------------------------- naming

def _safe_gloss(gloss: str) -> str:
    """ASL Citizen / WLASL convention: forbid path separators in directory names."""
    return gloss.replace("/", "_").replace("\\", "_").replace(" ", "_").strip()


def _safe_pid(pid: str | int) -> str:
    return str(pid).strip().replace("/", "_").replace("\\", "_") or "unknown"


def _signer_dir_name(pid: str | int) -> str:
    """Match the ``kaggle_<pid>`` convention so ``data/splits/kaggle_islr.json``
    can list signer ids directly. Distinct from ``asl_citizen_<pid>`` and
    ``wlasl_<split>`` to prevent cross-dataset collisions in tfrecords scan.
    """
    return f"kaggle_p{_safe_pid(pid)}"


# --------------------------------------------------------------------------- vocab + alias

def _vocab_with_aliases(sign_to_idx: dict[str, int]) -> tuple[list[str], dict[str, list[str]]]:
    """Build the 250-class vocab list and a per-class alias spelling list.

    The on-disk gloss directory uses the FIRST entry of ``expand_aliases(sign)``
    that's a valid filesystem name -- typically the upper-case form (e.g.
    "MILK" rather than "milk") so this dataset's clips stack into the same
    gloss directories as the ASL Citizen / WLASL caches when their vocabs
    collide. ``vocab.json`` then preserves the original Kaggle spellings as
    well as the chosen on-disk name, so downstream alias-aware loaders can
    union by either form.
    """
    try:
        from .gloss_aliases import expand_aliases
    except ImportError:
        from src.data.gloss_aliases import expand_aliases  # type: ignore
    vocab: list[str] = []
    aliases: dict[str, list[str]] = {}
    for sign in sorted(sign_to_idx, key=lambda s: sign_to_idx[s]):
        forms = expand_aliases(sign)
        chosen = _safe_gloss(forms[0]) if forms else _safe_gloss(sign)
        vocab.append(chosen)
        aliases[chosen] = forms
    return vocab, aliases


# --------------------------------------------------------------------------- parquet -> (T, 543, 3)

def parquet_to_tensor(parquet_path: Path) -> np.ndarray:
    """Pivot a single Kaggle ISLR parquet into a (T, 543, 3) numpy array.

    Layout matches src/landmarks.py: [Pose(33), Face(468), LHand(21), RHand(21)].
    Missing landmarks remain NaN (the upstream MediaPipe extraction marks them
    that way; preprocess_numpy expects NaN-marked missing).
    """
    df = pd.read_parquet(parquet_path, columns=["frame", "type", "landmark_index", "x", "y", "z"])
    if df.empty:
        # Empty parquet -> single all-NaN frame so downstream resize doesn't crash.
        return np.full((1, N_TOTAL, 3), np.nan, dtype=np.float32)

    # Compact frame -> dense [0..T) so we can index directly without large NaN gaps.
    frame_codes, _ = pd.factorize(df["frame"], sort=True)
    df = df.assign(_frame_dense=frame_codes)
    t = int(df["_frame_dense"].max()) + 1
    out = np.full((t, N_TOTAL, 3), np.nan, dtype=np.float32)

    type_offset = {
        "pose":       LOCAL_POSE_OFFSET,
        "face":       LOCAL_FACE_OFFSET,
        "left_hand":  LOCAL_LHAND_OFFSET,
        "right_hand": LOCAL_RHAND_OFFSET,
    }
    type_size = {"pose": N_POSE, "face": N_FACE, "left_hand": N_LHAND, "right_hand": N_RHAND}

    for tname, off in type_offset.items():
        sel = df[df["type"] == tname]
        if sel.empty:
            continue
        idx = sel["landmark_index"].to_numpy(dtype=np.int64)
        size = type_size[tname]
        in_range = (idx >= 0) & (idx < size)
        if not in_range.all():
            sel = sel.iloc[in_range]
            idx = idx[in_range]
        frames = sel["_frame_dense"].to_numpy(dtype=np.int64)
        out[frames, off + idx, 0] = sel["x"].to_numpy(dtype=np.float32)
        out[frames, off + idx, 1] = sel["y"].to_numpy(dtype=np.float32)
        out[frames, off + idx, 2] = sel["z"].to_numpy(dtype=np.float32)
    return out


# --------------------------------------------------------------------------- worker

_train_root = None  # type: ignore[assignment]


def _init_worker(train_root_str: str):
    global _train_root
    _train_root = Path(train_root_str)


def _process_one(task: tuple[str, str, str]) -> tuple[str, str]:
    """Args: (relative_parquet_path, gloss, out_path). Returns (out_path, status)."""
    rel_pq, _gloss, out_path = task
    out = Path(out_path)
    if out.exists() and out.stat().st_size > 0:
        return (out_path, "exists")
    try:
        arr = parquet_to_tensor(_train_root / rel_pq)
        if arr.shape[0] < 4:
            return (out_path, "empty")
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.parent / f".{out.name}.partial.npy"
        np.save(tmp, arr)
        tmp.rename(out)
        return (out_path, "ok")
    except Exception as e:
        return (out_path, f"error:{type(e).__name__}:{e!s:.80}")


# --------------------------------------------------------------------------- schema validation

def validate_schema(train_root: Path, train_csv: pd.DataFrame, n_samples: int = 5) -> None:
    """Sanity-check N random clips: shape, coord ranges, per-part NaN bands.

    Raises a clear error when something is off; prints a summary table on
    success. Run this BEFORE any pod spend so MediaPipe-version drift surfaces
    in seconds, before any pod spend.
    """
    rng = np.random.default_rng(seed=0)
    sample_idx = rng.choice(len(train_csv), size=min(n_samples, len(train_csv)), replace=False)
    print(f"[kaggle-islr] validating schema on {len(sample_idx)} random clips...")
    rows = []
    for i in sample_idx:
        row = train_csv.iloc[int(i)]
        rel = row["path"]
        arr = parquet_to_tensor(train_root / rel)
        if arr.ndim != 3 or arr.shape[1:] != (N_TOTAL, 3):
            sys.exit(f"FAIL shape: {rel} -> {arr.shape}; expected (T, 543, 3)")
        # Coord range check (skip NaN).
        finite = np.isfinite(arr)
        x = arr[..., 0][finite[..., 0]]
        y = arr[..., 1][finite[..., 1]]
        if x.size == 0 or y.size == 0:
            print(f"[kaggle-islr] WARN all-NaN clip: {rel}")
            continue
        if not (-0.5 <= x.min() and x.max() <= 1.5):
            sys.exit(f"FAIL x range: {rel} -> [{x.min():.3f}, {x.max():.3f}]; "
                     f"expected ~[0, 1] (normalized image coords)")
        if not (-0.5 <= y.min() and y.max() <= 1.5):
            sys.exit(f"FAIL y range: {rel} -> [{y.min():.3f}, {y.max():.3f}]; "
                     f"expected ~[0, 1]")
        # Per-part NaN frequency.
        nan_pct = {}
        for tname, off, size in (
            ("pose", LOCAL_POSE_OFFSET, N_POSE),
            ("face", LOCAL_FACE_OFFSET, N_FACE),
            ("left_hand", LOCAL_LHAND_OFFSET, N_LHAND),
            ("right_hand", LOCAL_RHAND_OFFSET, N_RHAND),
        ):
            block = arr[:, off:off + size, :]
            n_total = block.shape[0] * size
            n_nan = int(np.isnan(block[..., 0]).sum())
            nan_pct[tname] = n_nan / max(n_total, 1)
        rows.append((Path(rel).name, arr.shape[0], nan_pct))

    print(f"\n[kaggle-islr] schema OK on {len(rows)} clips.")
    print(f"  {'clip':<40s} {'T':>4s} {'face%':>6s} {'lh%':>6s} {'pose%':>6s} {'rh%':>6s}")
    for name, t, nan_pct in rows:
        print(f"  {name:<40s} {t:>4d} "
              f"{nan_pct['face']*100:>5.1f}% "
              f"{nan_pct['left_hand']*100:>5.1f}% "
              f"{nan_pct['pose']*100:>5.1f}% "
              f"{nan_pct['right_hand']*100:>5.1f}%")
    # Aggregate band check (warn-only; some clips exceed bands legitimately).
    avg = {tname: np.mean([r[2][tname] for r in rows]) for tname in NAN_BAND}
    for tname, (lo, hi) in NAN_BAND.items():
        if not (lo <= avg[tname] <= hi):
            print(f"[kaggle-islr] WARN avg {tname} NaN frac {avg[tname]:.2f} "
                  f"outside expected [{lo:.2f}, {hi:.2f}] -- possible "
                  "MediaPipe-version drift; train a smoke run before scaling up.")


# --------------------------------------------------------------------------- splits

def _write_default_splits(participants: list[str], out_path: Path) -> None:
    """Write a deterministic signer-disjoint split file at
    ``data/splits/kaggle_islr.json``. Last 4 participants by sorted id -> val
    signer; previous 4 -> val (within-train); rest -> train. The PopSign paper
    used 31 train / 8 val / 8 test signers, but Kaggle ISLR ships with 21 unique
    participants, so we go ~13/4/4. Adjust by editing the file directly.
    """
    sorted_pids = sorted(participants)
    n = len(sorted_pids)
    n_held = max(1, n // 5)
    n_val = max(1, n // 5)
    held = sorted_pids[-n_held:]
    val = sorted_pids[-(n_held + n_val):-n_held] if n_held > 0 else []
    train = sorted_pids[:-(n_held + n_val)] if n_val > 0 else sorted_pids
    payload = {
        "_comment": (
            "Kaggle ISLR (asl-signs) signer-disjoint split. Generated by "
            "src/data/kaggle_islr_loader.py from the participants present in "
            "train.csv. ``train_signers`` go into the training pool; ``val_signers`` "
            "are held out for in-domain val_acc; ``held_out_signers`` are the "
            "primary signer-generalization metric (val_signer_acc). Edit by hand "
            "to rebalance."
        ),
        "train_signers": [_signer_dir_name(p) for p in train],
        "val_signers":   [_signer_dir_name(p) for p in val],
        "held_out_signers": [_signer_dir_name(p) for p in held],
        "random_seed": 42,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2))
    print(f"[kaggle-islr] wrote splits -> {out_path} "
          f"(train={len(train)} val={len(val)} held={len(held)})")


# --------------------------------------------------------------------------- main

def _resolve_dataset_root(args) -> Path:
    if args.source_dir:
        root = Path(args.source_dir)
        if not root.exists():
            sys.exit(f"ERROR: --source-dir {root} does not exist")
        return root
    _check_kaggle_credentials()
    try:
        import kagglehub
    except ImportError:
        sys.exit("ERROR: kagglehub not installed. Run `pip install kagglehub`.")
    print(f"[kaggle-islr] downloading competition '{args.competition}' (~40 GB)")
    download_root = Path(kagglehub.competition_download(args.competition))
    print(f"[kaggle-islr] dataset at {download_root}")
    # Some kagglehub versions extract directly; others nest under versions/1/.
    candidates = [download_root, *download_root.glob("**/train.csv")]
    for c in candidates:
        candidate_root = c.parent if c.name == "train.csv" else c
        if (candidate_root / "train.csv").exists():
            return candidate_root
    sys.exit(f"ERROR: could not locate train.csv under {download_root}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--competition", default=KAGGLE_COMPETITION,
                        help="Kaggle competition slug (default: asl-signs)")
    parser.add_argument("--source-dir", default=None,
                        help="skip download; use this already-extracted dataset root "
                             "(must contain train.csv + train_landmark_files/)")
    parser.add_argument("--out-dir", default="data/cache/kaggle_islr",
                        help="cache root to write into")
    parser.add_argument("--workers", type=int, default=8,
                        help="parquet -> npy converter workers (default 8). "
                             "Pure CPU; saturates at ~vcpu_count.")
    parser.add_argument("--limit-per-gloss", type=int, default=None,
                        help="cap clips per gloss (debugging only)")
    parser.add_argument("--validate-schema", action="store_true",
                        help="sanity-check 5 random clips and exit (no extraction)")
    parser.add_argument("--write-splits", default="data/splits/kaggle_islr.json",
                        help="path to write the signer-disjoint split file "
                             "(set to '' to skip)")
    parser.add_argument("--write-targeted-vocab", default=None,
                        help="path to (over)write a {'signs': [...]} targeted-vocab "
                             "file (matching data/vocab/coffee_chat.json format) using "
                             "the canonical sign_to_prediction_index_map.json from the "
                             "downloaded dataset. Updates data/vocab/kaggle_islr.json "
                             "in place. Exits after writing; no extraction.")
    parser.add_argument("--num-shards", type=int, default=1,
                        help="multi-pod fan-out: how many total shards")
    parser.add_argument("--shard-id", type=int, default=0,
                        help="multi-pod fan-out: this shard's index in [0, num_shards)")
    parser.add_argument("--skip-summary", action="store_true",
                        help="don't print the post-extract summary; orchestrator handles it")
    args = parser.parse_args()

    if args.num_shards < 1:
        sys.exit(f"--num-shards must be >= 1; got {args.num_shards}")
    if not (0 <= args.shard_id < args.num_shards):
        sys.exit(f"--shard-id must be in [0, {args.num_shards}); got {args.shard_id}")

    train_root = _resolve_dataset_root(args)
    train_csv_path = train_root / "train.csv"
    sign_map_path = train_root / "sign_to_prediction_index_map.json"
    if not train_csv_path.exists() or not sign_map_path.exists():
        sys.exit(f"ERROR: expected train.csv + sign_to_prediction_index_map.json under {train_root}")

    train_csv = pd.read_csv(train_csv_path)
    print(f"[kaggle-islr] train.csv: {len(train_csv)} rows, "
          f"{train_csv['participant_id'].nunique()} participants, "
          f"{train_csv['sign'].nunique()} unique signs")

    sign_to_idx = json.loads(sign_map_path.read_text())
    if len(sign_to_idx) != 250:
        print(f"[kaggle-islr] WARN sign_to_prediction_index_map has "
              f"{len(sign_to_idx)} entries; expected 250")

    if args.validate_schema:
        validate_schema(train_root, train_csv, n_samples=5)
        return

    if args.write_targeted_vocab:
        out_path = Path(args.write_targeted_vocab)
        signs_sorted = sorted(sign_to_idx, key=lambda s: sign_to_idx[s])
        payload = {
            "_note": (
                "Google Kaggle Isolated Sign Language Recognition (asl-signs) "
                "competition vocabulary. Regenerated from the authoritative "
                "sign_to_prediction_index_map.json by "
                "src/data/kaggle_islr_loader.py --write-targeted-vocab. Spellings "
                "are Kaggle's canonical lowercase form; "
                "src/data/gloss_aliases.expand_aliases maps each to ASL Citizen / "
                "WLASL conventions for cross-dataset broad pretrain."
            ),
            "_source_url": "https://www.kaggle.com/competitions/asl-signs/data",
            "n_signs": len(signs_sorted),
            "signs": signs_sorted,
        }
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(payload, indent=2) + "\n")
        print(f"[kaggle-islr] wrote targeted-vocab -> {out_path} "
              f"({len(signs_sorted)} signs)")
        return

    # Vocab + on-disk gloss-name resolution.
    #
    # ``vocab[i]`` is the on-disk gloss for the Kaggle sign whose prediction
    # index is ``i`` (see ``_vocab_with_aliases`` -- it sorts by
    # ``sign_to_idx[s]``). To pair each original Kaggle spelling with its
    # disk gloss we must walk the signs in that same prediction-index order;
    # zipping ``sign_to_idx`` (dict insertion order = JSON file order) against
    # ``vocab`` (prediction-index order) is only correct when the JSON
    # happens to already be sorted by index, which is not guaranteed.
    vocab, aliases = _vocab_with_aliases(sign_to_idx)
    signs_by_index = sorted(sign_to_idx, key=lambda s: sign_to_idx[s])
    kaggle_to_disk = {orig: vocab[i] for i, orig in enumerate(signs_by_index)}
    out_root = Path(args.out_dir)
    out_root.mkdir(parents=True, exist_ok=True)
    counts = Counter(train_csv["sign"])
    vocab_payload = {
        "vocab": vocab,
        "counts": {chosen: int(counts.get(orig, 0))
                   for orig, chosen in kaggle_to_disk.items()},
        "kaggle_to_disk": kaggle_to_disk,
        "aliases": aliases,
        "_note": (
            "Vocab is the 250 PopSign signs aliased into ASL Citizen / WLASL "
            "casing (typically upper-case) so cross-dataset training in "
            "configs/pretrain_phase1_broad.yaml unions the same gloss directories. "
            "kaggle_to_disk is the lookup we use at extraction time. aliases is "
            "the full ordered list from src/data/gloss_aliases.expand_aliases."
        ),
    }
    (out_root / "vocab.json").write_text(json.dumps(vocab_payload, indent=2))
    print(f"[kaggle-islr] wrote vocab.json (vocab={len(vocab)})")

    # Build task list. Disk gloss = aliased upper-case form.
    tasks: list[tuple[str, str, str]] = []
    per_gloss_count: Counter[str] = Counter()
    participants: set[str] = set()
    for _, row in train_csv.iterrows():
        kaggle_sign = row["sign"]
        disk_gloss = kaggle_to_disk.get(kaggle_sign)
        if disk_gloss is None:
            continue
        if (args.limit_per_gloss is not None
                and per_gloss_count[disk_gloss] >= args.limit_per_gloss):
            continue
        per_gloss_count[disk_gloss] += 1
        pid = row["participant_id"]
        participants.add(_safe_pid(pid))
        sig_dir = out_root / _signer_dir_name(pid)
        out_path = sig_dir / disk_gloss / f"{int(row['sequence_id'])}.npy"
        already = out_path.exists() and out_path.stat().st_size > 0
        if not already:
            tasks.append((row["path"], disk_gloss, str(out_path)))

    n_pre_shard = len(tasks)
    if args.num_shards > 1:
        tasks = [t for i, t in enumerate(tasks) if i % args.num_shards == args.shard_id]
        print(f"[kaggle-islr] shard {args.shard_id}/{args.num_shards}: "
              f"{len(tasks)}/{n_pre_shard} tasks after sharding")
    print(f"[kaggle-islr] tasks to extract: {len(tasks)} "
          f"({n_pre_shard - len(tasks) if args.num_shards == 1 else 'see shard line'} "
          f"already cached)")

    if args.write_splits:
        _write_default_splits(sorted(participants), Path(args.write_splits))

    if not tasks:
        print("[kaggle-islr] nothing to do; everything is already cached.")
        return

    t0 = time.time()
    n_ok = n_existed = n_empty = n_err = 0
    error_examples: list[str] = []
    with Pool(processes=args.workers,
              initializer=_init_worker,
              initargs=(str(train_root),)) as pool:
        for i, (out_path, status) in enumerate(tqdm(
            pool.imap_unordered(_process_one, tasks, chunksize=8),
            total=len(tasks),
            desc="convert",
            unit="clip",
        )):
            if status == "ok":
                n_ok += 1
            elif status == "exists":
                n_existed += 1
            elif status == "empty":
                n_empty += 1
            else:
                n_err += 1
                if len(error_examples) < 10:
                    msg = f"[kaggle-islr] WARN {status} {out_path}"
                    error_examples.append(msg)
                    print(msg, file=sys.stderr)
            if i + 1 == 100 and n_err > 50:
                pool.terminate()
                pool.join()
                raise RuntimeError(
                    f"aborting: {n_err}/100 clips errored in the first 100 "
                    f"results, indicating a systemic loader bug. Examples:\n"
                    + "\n".join(error_examples)
                )
            if (i + 1) % 1000 == 0:
                elapsed = time.time() - t0
                rate = (i + 1) / max(elapsed, 1e-3)
                eta_min = (len(tasks) - (i + 1)) / max(rate, 1e-3) / 60.0
                print(f"[kaggle-islr] {i+1}/{len(tasks)} done "
                      f"({rate:.1f} clips/sec, ETA {eta_min:.0f} min, "
                      f"errors so far: {n_err})")

    elapsed = time.time() - t0
    print(f"\n[kaggle-islr] extraction complete in {elapsed/60:.1f} min: "
          f"ok={n_ok} cached_already={n_existed} empty={n_empty} errors={n_err}")
    if not args.skip_summary:
        _print_summary(out_root, vocab)


def _print_summary(out_root: Path, vocab: list[str]) -> None:
    print("\n[kaggle-islr] participant summary (signer / clip count):")
    signer_dirs = sorted(d for d in out_root.iterdir()
                         if d.is_dir() and d.name.startswith("kaggle_p"))
    grand = 0
    for sd in signer_dirs:
        n = sum(1 for _ in sd.glob("*/*.npy"))
        grand += n
        if n:
            print(f"  {sd.name:25s} {n:>8d}")
    print(f"  {'TOTAL':25s} {grand:>8d}")
    print(f"[kaggle-islr] vocab size: {len(vocab)} glosses")


if __name__ == "__main__":
    main()
