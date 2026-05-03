"""Convert raw WLASL2000 mp4s into our (T, 543, 3) cache layout via MediaPipe.

Why this exists alongside ``wlasl_kaggle_loader.py``: that loader uses
MuteMotion's pre-extracted landmarks (top-682 glosses; 100% YouTube-link-rot
proof). This loader extracts our OWN MediaPipe landmarks from the raw mp4s
hosted at ``risangbaskoro/wlasl-processed`` (~10 GB; 12K clips covering all
2,000 glosses). Two reasons to do both:

  1. **Coverage**: 14 Coffee Chat lexicon signs are present in the raw 2,000-
     gloss WLASL2000 vocab but absent from MuteMotion's top-682 (and from
     ASL Citizen's top-500). Examples: ME, YOU, MY, YOUR, GOODBYE, YES, NO,
     GOOD, LIKE, LOVE, LEARN, FRIEND, ASL, HAPPY, NERVOUS.
  2. **Self-extracted parity**: MuteMotion's MediaPipe configuration may
     differ from ours (refine_face_landmarks, smoothing, etc.). Our
     extraction matches the demo's runtime config exactly, eliminating one
     source of train/serve drift.

Cache layout (per-participant, mirrors ASL Citizen v2):

    data/cache/wlasl_full/
        vocab.json
        participants.json                    # {signer_id: {n_clips}}
        participant_<signer_id>/<safe_gloss>/<video_id>.npy

Downstream: ``data/splits/asl_citizen.json`` (or a new wlasl-aware split)
should list ``participant_<wlasl_signer_id>`` ids in train/val/held buckets;
[`scripts/build_aslcitizen_splits.py`](../../scripts/build_aslcitizen_splits.py)
gains a ``--include-wlasl-raw`` flag to do this automatically by reading
``participants.json``.

Vocabulary selection is two-mode (matches asl_citizen_loader):

  * ``--top-k K`` (default 0 = all 2,000): keep the K most-populous glosses.
  * ``--gloss-list path.json`` (targeted): a lexicon JSON
    (``{"signs": ["DEAF", "EAT", ...]}``); aliases are expanded via
    ``src/data/gloss_aliases.expand_aliases``. Crucially, the new hyphen->
    space tier lets ``THANK-YOU`` resolve to WLASL's ``thank you`` spelling.

Frame trim: the WLASL JSON's ``frame_start`` / ``frame_end`` are 1-indexed and
inclusive; ``-1`` (or beyond clip length) means "to end". We honor them so
extracted clips contain only the labeled signing window.

Usage:
    python -m src.data.wlasl_raw_loader --top-k 0 --workers 16
    python -m src.data.wlasl_raw_loader --gloss-list data/vocab/aslcitizen_targeted.json
    python -m src.data.wlasl_raw_loader --source-dir /workspace/datasets/wlasl

Requires Kaggle credentials (~/.kaggle/kaggle.json or KAGGLE_USERNAME +
KAGGLE_KEY env vars). The dataset is publicly downloadable; no competition
rules to accept.
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
from tqdm import tqdm


KAGGLE_DATASET = "risangbaskoro/wlasl-processed"
WLASL_MANIFEST_NAME = "WLASL_v0.3.json"
VIDEOS_SUBDIR = "videos"

# Module-level worker globals; populated in `_init_worker`. Each Pool process
# loads its own MediaPipe Holistic graph (the C++ graph is not picklable).
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


# --------------------------------------------------------------------------- naming

def _safe_gloss(gloss: str) -> str:
    return gloss.replace("/", "_").replace("\\", "_").strip()


def _signer_dir_name(signer_id) -> str:
    """``participant_<signer_id>``; matches ASL Citizen v2 layout so the
    custom signer-disjoint split file can list both kinds of ids uniformly.
    """
    raw = str(signer_id).strip().replace("/", "_").replace("\\", "_") or "unknown"
    return f"participant_w{raw}"


# --------------------------------------------------------------------------- vocab

def _all_glosses_with_counts(manifest: list[dict]) -> tuple[list[str], dict[str, int]]:
    counts: Counter[str] = Counter()
    for entry in manifest:
        gloss = entry.get("gloss")
        if not gloss:
            continue
        n_inst = len(entry.get("instances") or [])
        if n_inst > 0:
            counts[_safe_gloss(gloss)] = n_inst
    return list(counts.keys()), dict(counts)


def _pick_top_k(manifest: list[dict], top_k: int) -> tuple[list[str], dict[str, int]]:
    _, counts = _all_glosses_with_counts(manifest)
    if top_k <= 0 or top_k >= len(counts):
        ordered = [g for g, _ in Counter(counts).most_common()]
    else:
        ordered = [g for g, _ in Counter(counts).most_common(top_k)]
    return ordered, counts


def _resolve_targeted_vocab(manifest: list[dict], gloss_list_path: Path
                            ) -> tuple[list[str], dict[str, int],
                                        dict[str, str | None]]:
    """Match a lexicon (canonical English labels) against WLASL2000's full
    vocab via alias expansion. Mirrors the same function in asl_citizen_loader.
    """
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

    _, counts_all = _all_glosses_with_counts(manifest)
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
            print(f"[wlasl-raw] WARN no alias of '{label}' found in WLASL2000; "
                  f"tried first 6: {expand_aliases(label)[:6]}",
                  file=sys.stderr)
            continue
        seen.add(chosen)
        vocab.append(chosen)
        counts[chosen] = counts_all[chosen]
    print(f"[wlasl-raw] targeted resolution: {len(vocab)}/{len(labels)} "
          f"lexicon entries matched")
    return vocab, counts, resolution


# --------------------------------------------------------------------------- worker

def _init_worker(model_complexity: int):
    """Per-process MediaPipe init."""
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


def _process_one(task: tuple[str, str, int, int]) -> tuple[str, str]:
    """Args: (video_path, out_path, frame_start, frame_end). Returns (out_path, status).

    frame_start, frame_end are 1-indexed inclusive in the WLASL convention;
    -1 (or > total_frames) means "to end".
    """
    video_path, out_path, fs, fe = task
    out = Path(out_path)
    if out.exists() and out.stat().st_size > 0:
        return (out_path, "exists")
    try:
        cap = _cv2.VideoCapture(video_path)
        if not cap.isOpened():
            return (out_path, "error:cannot_open")
        # Translate 1-indexed inclusive [fs, fe] to 0-indexed half-open [start, stop).
        start = max(0, int(fs) - 1) if fs and fs > 0 else 0
        stop = int(fe) if fe and fe > 0 else None  # None means "to end"
        seq = []
        idx = 0
        while True:
            ok, frame = cap.read()
            if not ok:
                break
            if idx >= start:
                rgb = _cv2.cvtColor(frame, _cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                result = _holistic.process(rgb)
                seq.append(_landmarks_from_result(result))
            idx += 1
            if stop is not None and idx >= stop:
                break
        cap.release()
        if not seq:
            return (out_path, "empty")
        arr = np.stack(seq, axis=0).astype(np.float32, copy=False)
        out.parent.mkdir(parents=True, exist_ok=True)
        # Atomic write: temp .partial.npy then rename, so a Ctrl-C mid-write
        # doesn't leave a half-truncated .npy that fools the "exists" check.
        tmp = out.parent / f".{out.name}.partial.npy"
        np.save(tmp, arr)
        tmp.rename(out)
        return (out_path, "ok")
    except Exception as e:
        return (out_path, f"error:{type(e).__name__}:{e!s:.80}")


# --------------------------------------------------------------------------- orchestration

def _build_tasks(manifest: list[dict], vocab: list[str], videos_dir: Path,
                 out_root: Path, limit_per_gloss: int | None
                 ) -> tuple[list[tuple[str, str, int, int]], dict[str, dict]]:
    """Return ([(video_path, out_path, frame_start, frame_end)], participants_metadata).

    Skips clips whose mp4 isn't on disk (link-rot from the original WLASL
    YouTube fetch is common). Skips clips whose output .npy already exists.
    """
    vocab_set = set(vocab)
    tasks: list[tuple[str, str, int, int]] = []
    per_gloss_count: Counter[str] = Counter()
    participants: dict[str, dict] = {}
    for entry in manifest:
        gloss = entry.get("gloss")
        if not gloss:
            continue
        safe = _safe_gloss(gloss)
        if safe not in vocab_set:
            continue
        for inst in entry.get("instances") or []:
            video_id = str(inst.get("video_id") or "").strip()
            if not video_id:
                continue
            if (limit_per_gloss is not None
                    and per_gloss_count[safe] >= limit_per_gloss):
                break
            mp4_path = videos_dir / f"{video_id}.mp4"
            if not mp4_path.exists():
                continue
            signer = inst.get("signer_id", "unknown")
            sig_dir = out_root / _signer_dir_name(signer)
            out_path = sig_dir / safe / f"{video_id}.npy"
            already = out_path.exists() and out_path.stat().st_size > 0
            fs = int(inst.get("frame_start") or 1)
            fe = int(inst.get("frame_end") or -1)
            if not already:
                tasks.append((str(mp4_path), str(out_path), fs, fe))
            per_gloss_count[safe] += 1
            meta = participants.setdefault(str(signer), {"n_clips": 0})
            meta["n_clips"] += 1
    return tasks, participants


def _write_done_markers(out_root: Path):
    if not out_root.exists():
        return
    for signer_dir in out_root.iterdir():
        if not signer_dir.is_dir() or not signer_dir.name.startswith("participant_w"):
            continue
        for gloss_dir in signer_dir.iterdir():
            if not gloss_dir.is_dir():
                continue
            n = sum(1 for _ in gloss_dir.glob("*.npy"))
            if n:
                (gloss_dir / "done.txt").write_text(f"{n}\n")


def _print_summary(out_root: Path, vocab: list[str]):
    print("\n[wlasl-raw] participant summary (signer / clip count):")
    signer_dirs = sorted(d for d in out_root.iterdir()
                         if d.is_dir() and d.name.startswith("participant_w"))
    grand = 0
    for sd in signer_dirs:
        n = sum(1 for _ in sd.glob("*/*.npy"))
        grand += n
        if n:
            print(f"  {sd.name:30s} {n:>8d}")
    print(f"  {'TOTAL':30s} {grand:>8d}")
    print(f"[wlasl-raw] vocab size: {len(vocab)} glosses")


# --------------------------------------------------------------------------- main

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top-k", type=int, default=0,
                        help="keep the K most-populous glosses (default 0 = "
                             "all 2,000). Ignored if --gloss-list given.")
    parser.add_argument("--gloss-list", type=Path, default=None,
                        help="path to a lexicon JSON ({'signs': [...]}); "
                             "aliases expanded via src/data/gloss_aliases.py.")
    parser.add_argument("--limit-per-gloss", type=int, default=None,
                        help="cap clips per gloss (debugging only)")
    parser.add_argument("--workers", type=int, default=8,
                        help="MediaPipe extraction workers (default 8)")
    parser.add_argument("--model-complexity", type=int, default=2, choices=(0, 1, 2),
                        help="MediaPipe Holistic model_complexity (default 2 to "
                             "match the live demo)")
    parser.add_argument("--out-dir", default="data/cache/wlasl_full",
                        help="cache root to write into")
    parser.add_argument("--dataset", default=KAGGLE_DATASET,
                        help="Kaggle dataset slug to download")
    parser.add_argument("--source-dir", default=None,
                        help="skip kagglehub download; use this already-extracted "
                             "WLASL2000 root (must contain WLASL_v0.3.json + videos/)")
    parser.add_argument("--vocab-from", default=None,
                        help="path to an existing vocab.json to reuse instead of "
                             "recomputing (required for fan-out so all shards see "
                             "the same task numbering)")
    parser.add_argument("--num-shards", type=int, default=1,
                        help="multi-pod fan-out shard count")
    parser.add_argument("--shard-id", type=int, default=0,
                        help="this pod's shard index in [0, num-shards)")
    parser.add_argument("--skip-summary", action="store_true",
                        help="don't write done.txt or print the summary; "
                             "the orchestrator handles that post-merge")
    parser.add_argument("--summary-only", action="store_true",
                        help="skip extraction; write done.txt + print summary "
                             "against whatever's already on disk under --out-dir")
    args = parser.parse_args()

    if args.num_shards < 1:
        sys.exit(f"--num-shards must be >= 1; got {args.num_shards}")
    if not (0 <= args.shard_id < args.num_shards):
        sys.exit(f"--shard-id must be in [0, {args.num_shards}); got {args.shard_id}")

    out_root = Path(args.out_dir)

    if args.summary_only:
        if not out_root.exists():
            sys.exit(f"ERROR: --summary-only but {out_root} does not exist")
        vj = out_root / "vocab.json"
        if not vj.exists():
            sys.exit(f"ERROR: --summary-only requires {vj}")
        vocab_data = json.loads(vj.read_text())
        vocab = vocab_data["vocab"] if isinstance(vocab_data, dict) else list(vocab_data)
        _write_done_markers(out_root)
        _print_summary(out_root, vocab)
        return

    if args.source_dir:
        wlasl_root = Path(args.source_dir)
        if not wlasl_root.exists():
            sys.exit(f"ERROR: --source-dir {wlasl_root} does not exist")
    else:
        _check_kaggle_credentials()
        try:
            import kagglehub
        except ImportError:
            sys.exit("ERROR: kagglehub not installed. Run `pip install kagglehub`.")
        print(f"[wlasl-raw] downloading {args.dataset} (~10 GB)")
        download_root = Path(kagglehub.dataset_download(args.dataset))
        print(f"[wlasl-raw] dataset at {download_root}")
        # Find the directory that has WLASL_v0.3.json next to a videos/ dir.
        candidates = list(download_root.glob(f"**/{WLASL_MANIFEST_NAME}"))
        if not candidates:
            sys.exit(f"ERROR: could not find {WLASL_MANIFEST_NAME} under {download_root}")
        wlasl_root = candidates[0].parent
    manifest_path = wlasl_root / WLASL_MANIFEST_NAME
    videos_dir = wlasl_root / VIDEOS_SUBDIR
    if not manifest_path.exists() or not videos_dir.exists():
        sys.exit(f"ERROR: expected {WLASL_MANIFEST_NAME} + {VIDEOS_SUBDIR}/ "
                 f"under {wlasl_root}")
    print(f"[wlasl-raw] using dataset root: {wlasl_root}")

    manifest = json.loads(manifest_path.read_text())
    print(f"[wlasl-raw] manifest entries: {len(manifest)}")

    resolution: dict[str, str | None] | None = None
    if args.vocab_from:
        vp = Path(args.vocab_from)
        if not vp.exists():
            sys.exit(f"ERROR: --vocab-from {vp} does not exist")
        vocab_data = json.loads(vp.read_text())
        vocab = vocab_data["vocab"] if isinstance(vocab_data, dict) else list(vocab_data)
        full_counts = vocab_data.get("counts", {}) if isinstance(vocab_data, dict) else {}
        print(f"[wlasl-raw] using vocab from {vp} (size={len(vocab)})")
    elif args.gloss_list is not None:
        vocab, full_counts, resolution = _resolve_targeted_vocab(manifest, args.gloss_list)
        if not vocab:
            sys.exit(
                "ERROR: 0 lexicon labels resolved against WLASL2000. Check "
                "the lexicon file format and gloss spellings."
            )
    else:
        vocab, full_counts = _pick_top_k(manifest, args.top_k)

    out_root.mkdir(parents=True, exist_ok=True)
    vocab_path = out_root / "vocab.json"
    if not args.vocab_from or vp.resolve() != vocab_path.resolve():
        payload = {"vocab": vocab,
                   "counts": {g: full_counts.get(g, 0) for g in vocab}}
        if resolution is not None:
            payload["resolution"] = resolution
        vocab_path.write_text(json.dumps(payload, indent=2))
        print(f"[wlasl-raw] wrote {vocab_path} (vocab={len(vocab)})")

    tasks, participants = _build_tasks(
        manifest, vocab, videos_dir, out_root, args.limit_per_gloss,
    )
    n_pre_shard = len(tasks)
    pj = out_root / "participants.json"
    pj.write_text(json.dumps(participants, indent=2, sort_keys=True))
    print(f"[wlasl-raw] wrote {pj} ({len(participants)} signer ids)")

    if args.num_shards > 1:
        tasks = [t for i, t in enumerate(tasks) if i % args.num_shards == args.shard_id]
        print(f"[wlasl-raw] shard {args.shard_id}/{args.num_shards}: "
              f"{len(tasks)}/{n_pre_shard} tasks after sharding")
    print(f"[wlasl-raw] tasks to extract: {len(tasks)}")

    if not tasks:
        print("[wlasl-raw] nothing to do; everything is already cached.")
        if not args.skip_summary:
            _write_done_markers(out_root)
            _print_summary(out_root, vocab)
        return

    t0 = time.time()
    n_ok = n_existed = n_empty = n_err = 0
    error_examples: list[str] = []
    with Pool(processes=args.workers,
              initializer=_init_worker,
              initargs=(args.model_complexity,)) as pool:
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
                    msg = f"[wlasl-raw] WARN {status} {out_path}"
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
                print(f"[wlasl-raw] {i+1}/{len(tasks)} done "
                      f"({rate:.1f} clips/sec, ETA {eta_min:.0f} min, "
                      f"errors so far: {n_err})")

    elapsed = time.time() - t0
    print(f"\n[wlasl-raw] extraction complete in {elapsed/60:.1f} min: "
          f"ok={n_ok} cached_already={n_existed} empty={n_empty} errors={n_err}")
    if not args.skip_summary:
        _write_done_markers(out_root)
        _print_summary(out_root, vocab)


if __name__ == "__main__":
    main()
