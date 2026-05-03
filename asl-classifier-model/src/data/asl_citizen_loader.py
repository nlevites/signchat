"""Download ASL Citizen and convert each clip into our (T, 543, 3) cache layout.

ASL Citizen (Microsoft Research, 2024) ships as ~84K mp4s recorded by 52 signers
on personal webcams across 2,731 ASL signs. We host-mirror via Kaggle slug
``abd0kamel/asl-citizen`` (42.8 GB) so it pulls with the same KAGGLE_USERNAME /
KAGGLE_KEY env vars used by `wlasl_kaggle_loader.py`. Microsoft's original
download URL works too but isn't stable across years.

Phase 0 conclusion: no Kaggle pre-extract preserves the (T, 543, 3) raw layout
with NaN-marked missing parts. Every uploader either fixes the temporal length
(minafarid01: 32 frames), uses a smaller landmark subset (nguyenchitinh: Kaggle
5th-place 75-point), or already encodes/normalizes the data (tobypu, minhoanvo).
DIY MediaPipe extraction is the cleanest path; this loader is its implementation.

Two cache layouts are supported (chosen by ``--per-participant``):

  Legacy (default for back-compat with v1 broad pretrain):

    data/cache/asl_citizen/
        vocab.json
        asl_citizen_train/<safe_gloss>/<video_id>.npy
        asl_citizen_val/<safe_gloss>/<video_id>.npy
        asl_citizen_test/<safe_gloss>/<video_id>.npy

  Per-participant (v2; required for custom signer-disjoint splits):

    data/cache/asl_citizen/
        vocab.json
        participants.json                           # {pid: {official_split, n_clips}}
        participant_<pid>/<safe_gloss>/<video_id>.npy

Vocabulary selection is also two-mode: ``--top-k K`` (default 500, "most
populous") OR ``--gloss-list path.json`` (targeted). The targeted mode reads a
lexicon JSON (``{"signs": ["DEAF", "EAT", ...]}`` with canonical English
labels), expands ASL-LEX-style aliases via ``src/data/gloss_aliases.py``, and
extracts every clip whose dataset gloss matches an alias for any lexicon entry.
This is what backs the broad+tight recipe.

Run with ``make asl-citizen`` (top-500, legacy layout) or
``make asl-citizen-targeted GLOSS_LIST=...`` (targeted, per-participant).

CLI: python -m src.data.asl_citizen_loader [--top-k 500 | --gloss-list path]
                                            [--per-participant]
                                            [--workers 8]
                                            [--limit-per-gloss K]
                                            [--out-dir data/cache/asl_citizen]
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
from collections import Counter
from multiprocessing import Pool
from pathlib import Path

import numpy as np
from tqdm import tqdm


KAGGLE_DATASET = "abd0kamel/asl-citizen"
SPLITS = ("train", "val", "test")

# Module-level worker globals; populated in `_init_worker`. Each Pool process
# loads its own MediaPipe Holistic graph (the C++ graph is not picklable, so it
# can't be sent across the fork boundary).
_holistic = None  # type: ignore
_cv2 = None  # type: ignore
_landmarks_from_result = None  # type: ignore


# --------------------------------------------------------------------------- credentials

def _check_kaggle_credentials():
    has_file = (Path.home() / ".kaggle" / "kaggle.json").exists()
    has_env = os.environ.get("KAGGLE_USERNAME") and os.environ.get("KAGGLE_KEY")
    if not (has_file or has_env):
        sys.exit(
            "ERROR: Kaggle credentials not found.\n"
            "  Option A: place kaggle.json at ~/.kaggle/kaggle.json (chmod 600).\n"
            "  Option B: set KAGGLE_USERNAME and KAGGLE_KEY env vars.\n"
            "Get a token at https://www.kaggle.com/settings -> 'Create New API Token'."
        )


# --------------------------------------------------------------------------- splits

def _safe_gloss(gloss: str) -> str:
    """Sanitize a gloss for use as a directory name. ASL Citizen contains a few
    glosses with '/' (e.g. 'HURDLE/TRIP1') that would otherwise become nested
    directories on disk; strip them to single-component names."""
    return gloss.replace("/", "_").replace("\\", "_").strip()


def _read_split_csv(csv_path: Path) -> list[tuple[str, str, str]]:
    """Return a list of (signer_id, video_filename, gloss) for one split CSV.

    ASL Citizen CSV header: "Participant ID,Video file,Gloss,ASL-LEX Code".
    Some gloss strings contain quoted commas; csv.reader handles that.
    """
    rows: list[tuple[str, str, str]] = []
    with csv_path.open(newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if not header or header[:3] != ["Participant ID", "Video file", "Gloss"]:
            raise RuntimeError(f"unexpected CSV header in {csv_path}: {header}")
        for row in reader:
            if len(row) < 3:
                continue
            rows.append((row[0].strip(), row[1].strip(), row[2].strip()))
    return rows


def _load_all_splits(asl_root: Path) -> dict[str, list[tuple[str, str, str]]]:
    """Return {split_name: [(signer, video_filename, gloss), ...]}."""
    out: dict[str, list[tuple[str, str, str]]] = {}
    for split in SPLITS:
        csv_path = asl_root / "splits" / f"{split}.csv"
        if not csv_path.exists():
            raise RuntimeError(f"split CSV not found: {csv_path}")
        out[split] = _read_split_csv(csv_path)
    return out


# --------------------------------------------------------------------------- vocab

def _pick_top_k_glosses(splits: dict[str, list[tuple[str, str, str]]],
                        top_k: int) -> tuple[list[str], dict[str, int]]:
    """Count gloss frequency across all splits; return (vocab_list, counts)."""
    counts: Counter[str] = Counter()
    for rows in splits.values():
        for _, _, gloss in rows:
            counts[_safe_gloss(gloss)] += 1
    if top_k <= 0 or top_k >= len(counts):
        # Use all glosses, ordered by population.
        ordered = [g for g, _ in counts.most_common()]
    else:
        ordered = [g for g, _ in counts.most_common(top_k)]
    return ordered, dict(counts)


def _resolve_targeted_vocab(splits: dict[str, list[tuple[str, str, str]]],
                            gloss_list_path: Path,
                            ) -> tuple[list[str], dict[str, int],
                                        dict[str, str | None]]:
    """Match a lexicon (canonical English labels) against ASL Citizen's full
    vocab via alias expansion. Return (vocab_list, counts, resolution_map).

    resolution_map: {canonical_label: matched_dataset_gloss | None}. None
    entries indicate the label couldn't be found in the dataset; logged but
    not extracted (the lexicon row is dropped from the vocab list).
    """
    # Local import: keeps the module importable when run from a checkout
    # without `src.` on sys.path (e.g. from CLI as a script).
    try:
        from .gloss_aliases import expand_aliases
    except ImportError:
        from src.data.gloss_aliases import expand_aliases  # type: ignore

    if not gloss_list_path.exists():
        sys.exit(f"ERROR: --gloss-list {gloss_list_path} does not exist")
    raw = json.loads(gloss_list_path.read_text())
    if isinstance(raw, list):
        labels = [str(x) for x in raw]
    elif isinstance(raw, dict) and "signs" in raw:
        labels = [str(x) for x in raw["signs"]]
    else:
        sys.exit(
            f"ERROR: --gloss-list {gloss_list_path} must be a list or "
            "{'signs': [...]}; got " + str(type(raw).__name__)
        )
    counts_all: Counter[str] = Counter()
    for rows in splits.values():
        for _, _, gloss in rows:
            counts_all[_safe_gloss(gloss)] += 1
    available = set(counts_all)

    vocab: list[str] = []
    counts: dict[str, int] = {}
    seen: set[str] = set()
    resolution: dict[str, str | None] = {}
    for label in labels:
        chosen: str | None = None
        for alias in expand_aliases(label):
            sg = _safe_gloss(alias)
            if sg in available and sg not in seen:
                chosen = sg
                break
        resolution[label] = chosen
        if chosen is None:
            print(f"[asl-citizen] WARN no alias of '{label}' found in dataset; "
                  f"tried first 6: {expand_aliases(label)[:6]}",
                  file=sys.stderr)
            continue
        seen.add(chosen)
        vocab.append(chosen)
        counts[chosen] = counts_all[chosen]
    print(f"[asl-citizen] targeted resolution: {len(vocab)}/{len(labels)} "
          f"lexicon entries matched")
    return vocab, counts, resolution


# --------------------------------------------------------------------------- worker

def _init_worker(model_complexity: int):
    """Per-process: import the heavy deps and build a MediaPipe Holistic graph
    once. Subsequent _process_one calls reuse it. ~1-2 sec startup per worker."""
    import cv2
    import mediapipe as mp
    from .mediapipe_runner import landmarks_from_result

    global _holistic, _cv2, _landmarks_from_result
    _cv2 = cv2
    _landmarks_from_result = landmarks_from_result
    _holistic = mp.solutions.holistic.Holistic(
        static_image_mode=False,
        model_complexity=model_complexity,
        smooth_landmarks=True,
        refine_face_landmarks=False,
        min_detection_confidence=0.5,
        min_tracking_confidence=0.5,
    )


def _process_one(task: tuple[str, str]) -> tuple[str, str]:
    """Worker entry point.

    Args:
        task: (video_path, out_path) as strings.
    Returns:
        (out_path, status) where status is "ok" | "exists" | "empty" | "error:<msg>".
    """
    video_path, out_path = task
    out = Path(out_path)
    if out.exists() and out.stat().st_size > 0:
        return (out_path, "exists")
    try:
        cap = _cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return (out_path, "error:cannot_open")
        seq = []
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            rgb = _cv2.cvtColor(frame, _cv2.COLOR_BGR2RGB)
            rgb.flags.writeable = False
            result = _holistic.process(rgb)
            seq.append(_landmarks_from_result(result))
        cap.release()
        if not seq:
            return (out_path, "empty")
        arr = np.stack(seq, axis=0).astype(np.float32, copy=False)
        out.parent.mkdir(parents=True, exist_ok=True)
        # Atomic-ish write: temp then rename, so a Ctrl-C mid-write doesn't
        # leave a half-truncated .npy that fools the "exists" check.
        # IMPORTANT: numpy.save auto-appends `.npy` if the path doesn't end in
        # one - so we MUST end the temp path in `.npy` to prevent it from
        # writing to `<tmp>.npy` (which would then make the rename fail with
        # a FileNotFoundError on the original `<tmp>` we tried to save to).
        tmp = out.parent / f".{out.name}.partial.npy"
        np.save(tmp, arr)
        tmp.rename(out)
        return (out_path, "ok")
    except Exception as e:
        # Bumped from :.80 to :.500 so MediaPipe Calculator::Open errors
        # surface their full payload (the C++ stack frame names plus the
        # missing-model-asset path are usually past byte 80).
        return (out_path, f"error:{type(e).__name__}:{e!s:.500}")


# --------------------------------------------------------------------------- orchestration

def _signer_dir_name(per_participant: bool, signer: str, split: str) -> str:
    """Return the cache subdir name for a clip's signer dimension.

    * per_participant=True -> ``participant_<pid>`` (the ASL Citizen
      Participant ID, sanitized). Enables custom signer-disjoint splits in
      ``data/splits/asl_citizen.json`` because tfrecords.py treats the first
      cache subdir as the signer id.
    * per_participant=False -> ``asl_citizen_<split>`` (legacy v1 layout).
    """
    if per_participant:
        # Participant IDs in ASL Citizen are short alnum strings (e.g. "p0"
        # through "p51"). Sanitize defensively for filesystem safety.
        clean = signer.strip().replace("/", "_").replace("\\", "_") or "unknown"
        return f"participant_{clean}"
    return f"asl_citizen_{split}"


def _build_tasks(splits: dict[str, list[tuple[str, str, str]]],
                 vocab: list[str], asl_root: Path, out_root: Path,
                 limit_per_gloss: int | None,
                 per_participant: bool = False
                 ) -> tuple[list[tuple[str, str]], dict[str, dict]]:
    """Return ([(video_path, out_path)], participants_metadata).

    participants_metadata is ``{pid: {"official_split": "train"|"val"|"test",
    "n_clips": N}}`` aggregated across the SELECTED clips (i.e. the same set
    that the returned tasks plus already-cached clips cover).

    Skips tasks whose output .npy already exists (cheap resumability check
    that runs in the parent process before the Pool, so workers don't waste a
    fork).
    """
    vocab_set = set(vocab)
    videos_dir = asl_root / "videos"
    tasks: list[tuple[str, str]] = []
    per_gloss_count: Counter[str] = Counter()
    participants: dict[str, dict] = {}
    for split, rows in splits.items():
        for signer, video_file, gloss in rows:
            safe = _safe_gloss(gloss)
            if safe not in vocab_set:
                continue
            key = (split, safe)
            if limit_per_gloss is not None and per_gloss_count[key] >= limit_per_gloss:
                continue
            sig_dir = _signer_dir_name(per_participant, signer, split)
            cache_subdir = out_root / sig_dir
            video_path = videos_dir / video_file
            stem = Path(video_file).stem
            out_path = cache_subdir / safe / f"{stem}.npy"
            already = out_path.exists() and out_path.stat().st_size > 0
            if not already:
                tasks.append((str(video_path), str(out_path)))
            per_gloss_count[key] += 1
            if per_participant:
                meta = participants.setdefault(
                    signer.strip(), {"official_split": split, "n_clips": 0},
                )
                # If a participant somehow appears in multiple official splits
                # (shouldn't, but be defensive), record the split-of-first-seen
                # but tally clips across all splits.
                meta["n_clips"] += 1
    return tasks, participants


def _write_done_markers(out_root: Path, per_participant: bool):
    """After extraction, write done.txt in each ``<signer_dir>/<gloss>/``
    directory that has any .npy files. Lets a re-run quickly check
    completeness without stat-ing every clip.
    """
    if not out_root.exists():
        return
    for signer_dir in out_root.iterdir():
        if not signer_dir.is_dir():
            continue
        # Only walk known signer-dir prefixes to avoid scanning unrelated subdirs
        if per_participant:
            if not signer_dir.name.startswith("participant_"):
                continue
        else:
            if not signer_dir.name.startswith("asl_citizen_"):
                continue
        for gloss_dir in signer_dir.iterdir():
            if not gloss_dir.is_dir():
                continue
            n = sum(1 for _ in gloss_dir.glob("*.npy"))
            if n:
                (gloss_dir / "done.txt").write_text(f"{n}\n")


def _print_summary(out_root: Path, vocab: list[str], per_participant: bool):
    if per_participant:
        print("\n[asl-citizen] participant summary (per signer / per gloss):")
        signer_dirs = sorted(d for d in out_root.iterdir()
                             if d.is_dir() and d.name.startswith("participant_"))
        grand = 0
        for sd in signer_dirs:
            n = sum(1 for _ in sd.glob("*/*.npy"))
            grand += n
            if n:
                print(f"  {sd.name:30s} {n:>8d}")
        print(f"  {'TOTAL':30s} {grand:>8d}")
    else:
        print("\n[asl-citizen] split summary (clips per ASL Citizen split):")
        grand = 0
        for split in SPLITS:
            split_root = out_root / f"asl_citizen_{split}"
            n = sum(1 for _ in split_root.glob("*/*.npy")) if split_root.exists() else 0
            grand += n
            print(f"  {split_root.name:25s} {n:>8d}")
        print(f"  {'TOTAL':25s} {grand:>8d}")
    print(f"[asl-citizen] vocab size: {len(vocab)} glosses")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top-k", type=int, default=500,
                        help="keep the K most-populous glosses (default 500; "
                             "0 means use all 2,731). Ignored if --gloss-list given.")
    parser.add_argument("--gloss-list", type=Path, default=None,
                        help="path to a lexicon JSON ({\"signs\": [...]}) of "
                             "canonical English labels; aliases are expanded via "
                             "src/data/gloss_aliases.py and matched against ASL "
                             "Citizen's full vocab. When set, supersedes --top-k.")
    parser.add_argument("--per-participant", action="store_true",
                        help="write per-participant cache layout "
                             "(participant_<pid>/<gloss>/*.npy + participants.json) "
                             "instead of the legacy per-split layout. Required for "
                             "custom signer-disjoint splits in v2 broad+tight.")
    parser.add_argument("--limit-per-gloss", type=int, default=None,
                        help="cap clips per (split, gloss) (debugging only)")
    parser.add_argument("--workers", type=int, default=8,
                        help="MediaPipe extraction workers (default 8)")
    parser.add_argument("--model-complexity", type=int, default=2, choices=(0, 1, 2),
                        help="MediaPipe Holistic model_complexity (default 2 to "
                             "match the live demo and MuteMotion's likely setting)")
    parser.add_argument("--out-dir", default="data/cache/asl_citizen",
                        help="cache root to write into")
    parser.add_argument("--dataset", default=KAGGLE_DATASET,
                        help="Kaggle dataset slug to download")
    parser.add_argument("--source-dir", default=None,
                        help="skip kagglehub download; use this already-extracted "
                             "ASL_Citizen/ root (containing splits/ + videos/)")
    parser.add_argument("--vocab-from", default=None,
                        help="path to an existing vocab.json to reuse instead "
                             "of recomputing top-K (required for fan-out so all "
                             "shards agree on the vocab without race conditions)")
    parser.add_argument("--num-shards", type=int, default=1,
                        help="total shard count for multi-pod fan-out "
                             "(default 1 = no sharding; this pod processes all tasks)")
    parser.add_argument("--shard-id", type=int, default=0,
                        help="this pod's shard index in [0, num-shards). Tasks are "
                             "deterministically partitioned via i %% num_shards, so "
                             "shards are exactly disjoint and cover the original task list.")
    parser.add_argument("--skip-summary", action="store_true",
                        help="don't write done.txt or print the split summary; "
                             "the orchestrator handles that post-merge so per-shard "
                             "runs don't see an incomplete view of the cache.")
    parser.add_argument("--summary-only", action="store_true",
                        help="skip extraction entirely; just write done.txt markers "
                             "and print the split summary against whatever's already "
                             "on disk under --out-dir. Used by the merge step.")
    args = parser.parse_args()

    if args.num_shards < 1:
        sys.exit(f"--num-shards must be >= 1; got {args.num_shards}")
    if not (0 <= args.shard_id < args.num_shards):
        sys.exit(f"--shard-id must be in [0, {args.num_shards}); got {args.shard_id}")

    out_root = Path(args.out_dir)

    if args.summary_only:
        # Standalone post-merge pass: don't load the dataset, don't extract
        # anything; just walk the existing cache and emit summary + done.txt.
        if not out_root.exists():
            sys.exit(f"ERROR: --summary-only but {out_root} does not exist")
        vj = out_root / "vocab.json"
        if not vj.exists():
            sys.exit(f"ERROR: --summary-only requires {vj}")
        vocab_data = json.loads(vj.read_text())
        vocab = vocab_data["vocab"] if isinstance(vocab_data, dict) else list(vocab_data)
        # Detect layout from existing on-disk subdirs.
        existing_per_pp = any(
            d.is_dir() and d.name.startswith("participant_")
            for d in out_root.iterdir()
        )
        _write_done_markers(out_root, per_participant=existing_per_pp)
        _print_summary(out_root, vocab, per_participant=existing_per_pp)
        return

    if args.source_dir:
        asl_root = Path(args.source_dir)
        if not asl_root.exists():
            sys.exit(f"ERROR: --source-dir {asl_root} does not exist")
    else:
        _check_kaggle_credentials()
        try:
            import kagglehub
        except ImportError:
            sys.exit("ERROR: kagglehub not installed. Run `pip install kagglehub`.")
        print(f"[asl-citizen] downloading {args.dataset} (~42.8 GB)")
        download_root = Path(kagglehub.dataset_download(args.dataset))
        print(f"[asl-citizen] dataset at {download_root}")
        # Kagglehub extracts to .../<slug>/versions/1/. The ZIP unpacks to a
        # top-level "ASL_Citizen/" directory. Search for it (allow either the
        # extracted directory or the parent).
        candidates = list(download_root.glob("**/ASL_Citizen"))
        if not candidates:
            candidates = list(download_root.glob("**/splits"))
            if candidates:
                asl_root = candidates[0].parent
            else:
                sys.exit(f"ERROR: could not find ASL_Citizen/ under {download_root}")
        else:
            asl_root = candidates[0]
    print(f"[asl-citizen] using dataset root: {asl_root}")

    splits = _load_all_splits(asl_root)
    n_total = sum(len(v) for v in splits.values())
    print(f"[asl-citizen] split sizes: " +
          ", ".join(f"{k}={len(v)}" for k, v in splits.items()) +
          f"; total={n_total}")

    resolution: dict[str, str | None] | None = None
    if args.vocab_from:
        # Fan-out path: every shard reads the SAME vocab.json the orchestrator
        # wrote, so all shards see an identical task numbering and the mod
        # partition is exactly disjoint and complete.
        vp = Path(args.vocab_from)
        if not vp.exists():
            sys.exit(f"ERROR: --vocab-from {vp} does not exist")
        vocab_data = json.loads(vp.read_text())
        vocab = vocab_data["vocab"] if isinstance(vocab_data, dict) else list(vocab_data)
        full_counts = vocab_data.get("counts", {}) if isinstance(vocab_data, dict) else {}
        print(f"[asl-citizen] using vocab from {vp} (size={len(vocab)})")
    elif args.gloss_list is not None:
        vocab, full_counts, resolution = _resolve_targeted_vocab(splits, args.gloss_list)
        if not vocab:
            sys.exit(
                "ERROR: 0 lexicon labels resolved against ASL Citizen. "
                "Check the lexicon file format and gloss spellings."
            )
    else:
        vocab, full_counts = _pick_top_k_glosses(splits, args.top_k)

    out_root.mkdir(parents=True, exist_ok=True)
    vocab_path = out_root / "vocab.json"
    if not args.vocab_from or vp.resolve() != vocab_path.resolve():
        # Don't rewrite vocab.json if --vocab-from points at the very file we
        # would write; otherwise concurrent shards racing the same write are
        # fine because they're writing identical content (the file size and
        # bytes match), but we still avoid the redundant IO.
        vocab_payload = {"vocab": vocab,
                         "counts": {g: full_counts.get(g, 0) for g in vocab}}
        if resolution is not None:
            vocab_payload["resolution"] = resolution
        vocab_path.write_text(json.dumps(vocab_payload, indent=2))
        print(f"[asl-citizen] wrote {vocab_path} (vocab={len(vocab)})")

    tasks, participants = _build_tasks(
        splits, vocab, asl_root, out_root, args.limit_per_gloss,
        per_participant=args.per_participant,
    )
    n_pre_shard = len(tasks)
    if args.per_participant:
        # Write participants.json from the FULL participant set (not sharded),
        # so the merge step has a complete view. Each shard is a strict subset
        # of clips; all shards see the same participants metadata since it's
        # derived from the official splits CSV, not from on-disk results.
        pj = out_root / "participants.json"
        pj.write_text(json.dumps(participants, indent=2, sort_keys=True))
        print(f"[asl-citizen] wrote {pj} ({len(participants)} participants)")
    if args.num_shards > 1:
        tasks = [t for i, t in enumerate(tasks) if i % args.num_shards == args.shard_id]
        print(f"[asl-citizen] shard {args.shard_id}/{args.num_shards}: "
              f"{len(tasks)}/{n_pre_shard} tasks after sharding")
    print(f"[asl-citizen] tasks to extract: {len(tasks)} "
          f"(skipping clips already cached on disk)")
    if not tasks:
        print("[asl-citizen] nothing to do; everything is already cached.")
        if not args.skip_summary:
            _write_done_markers(out_root, per_participant=args.per_participant)
            _print_summary(out_root, vocab, per_participant=args.per_participant)
        return

    t0 = time.time()
    n_ok = n_existed = n_empty = n_err = 0
    error_examples: list[str] = []
    with Pool(processes=args.workers,
              initializer=_init_worker,
              initargs=(args.model_complexity,)) as pool:
        # imap_unordered is the right shape: workers handle clips in any order,
        # tqdm gives us a live throughput estimate so we can extrapolate from
        # the first ~5 minutes whether the pod's clips/sec rate is acceptable.
        for i, (out_path, status) in enumerate(tqdm(
            pool.imap_unordered(_process_one, tasks, chunksize=4),
            total=len(tasks),
            desc="extract",
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
                    msg = f"[asl-citizen] WARN {status} {out_path}"
                    error_examples.append(msg)
                    print(msg, file=sys.stderr)
            # Early-bail if the first 100 results show >50% error rate. This
            # protects against systemic loader bugs costing hours of pod time.
            if i + 1 == 100 and n_err > 50:
                pool.terminate()
                pool.join()
                raise RuntimeError(
                    f"aborting: {n_err}/100 clips errored in the first 100 "
                    f"results, indicating a systemic loader bug. Examples:\n"
                    + "\n".join(error_examples)
                )
            # Periodic rate report (separate from the tqdm bar so it lands in
            # the pod's stdout log too).
            if (i + 1) % 1000 == 0:
                elapsed = time.time() - t0
                rate = (i + 1) / max(elapsed, 1e-3)
                eta_min = (len(tasks) - (i + 1)) / max(rate, 1e-3) / 60.0
                print(f"[asl-citizen] {i+1}/{len(tasks)} done "
                      f"({rate:.1f} clips/sec, ETA {eta_min:.0f} min, "
                      f"errors so far: {n_err})")

    elapsed = time.time() - t0
    print(f"\n[asl-citizen] extraction complete in {elapsed/60:.1f} min: "
          f"ok={n_ok} cached_already={n_existed} empty={n_empty} errors={n_err}")
    if not args.skip_summary:
        _write_done_markers(out_root, per_participant=args.per_participant)
        _print_summary(out_root, vocab, per_participant=args.per_participant)


if __name__ == "__main__":
    main()
