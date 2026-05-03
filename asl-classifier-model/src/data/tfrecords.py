"""tf.data pipeline that reads cached landmark .npy files.

Cache layout expected:
    <cache_dir>/<signer_id>/<sign>/*.npy        # arrays of shape (T, 543, 3)

We do NOT use TFRecords for the MVP - .npy files are simple, debuggable, and
fast enough for the dataset sizes we're targeting (~thousands of clips). The
file is named tfrecords.py because that's what the plan called the module;
swapping in TFRecord-backed loading later is straightforward.

Two layered features support multi-dataset pretrain (Phase 1):

  * `cache_dir` may be a single string or a list of strings; refs from each
    are unioned (deduped by absolute path).
  * `vocab: auto` reads `vocab.json` from each cache dir and unions the
    label lists, preserving first-dir ordering then appending new entries
    from subsequent dirs.

Splits support either the original 2-way schema (just `held_out_signers` plus a
within-train val_fraction) or an explicit 3-way schema (`train_signers`,
`val_signers`, `held_out_signers`) - the latter is what the ASL Citizen + WLASL
multi-dataset config uses, since both datasets ship with their own train/val/test
signer assignments and we want to honor those exactly rather than re-cut a val.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import tensorflow as tf

from .. import preprocessing as pp
from ..augment import build_augment_fn, build_batch_cutmix


@dataclass
class ClipRef:
    path: Path
    sign: str
    signer: str
    label: int
    source: str = ""   # cache_dir.name (e.g. "asl_citizen", "kaggle_islr"); used
                       # by the training pipeline for per-source balanced sampling


# --------------------------------------------------------------------------- cache scan

def _as_dir_list(cache_dir) -> list[Path]:
    """Normalize cfg.data.cache_dir to a list of Paths."""
    if isinstance(cache_dir, (list, tuple)):
        return [Path(d) for d in cache_dir]
    return [Path(cache_dir)]


def _scan_cache(cache_dirs: Iterable[Path], vocab: list[str]) -> list[ClipRef]:
    """Scan one or more cache roots for clips whose sign is in `vocab`.

    Refs are deduped by absolute path so overlapping caches don't double-count.
    Each ref is annotated with its ``source`` (the cache dir basename) so the
    training pipeline can group by source for balanced sampling.
    """
    label_map = {s: i for i, s in enumerate(vocab)}
    seen: set[Path] = set()
    refs: list[ClipRef] = []
    for cache_dir in cache_dirs:
        if not cache_dir.exists():
            continue
        source = cache_dir.name
        for signer_dir in sorted(cache_dir.iterdir()):
            if not signer_dir.is_dir():
                continue
            for sign_dir in sorted(signer_dir.iterdir()):
                if not sign_dir.is_dir() or sign_dir.name not in label_map:
                    continue
                for npy in sorted(sign_dir.glob("*.npy")):
                    abs_path = npy.resolve()
                    if abs_path in seen:
                        continue
                    seen.add(abs_path)
                    refs.append(ClipRef(
                        path=npy, sign=sign_dir.name, signer=signer_dir.name,
                        label=label_map[sign_dir.name], source=source,
                    ))
    return refs


# --------------------------------------------------------------------------- splits

def _load_split(splits_path: Path) -> dict:
    if not splits_path.exists():
        return {"held_out_signers": [], "val_fraction_within_train_signers": 0.15,
                "random_seed": 42}
    with splits_path.open() as f:
        return json.load(f)


def _split_refs_explicit(refs: list[ClipRef], split_cfg: dict
                         ) -> tuple[list[ClipRef], list[ClipRef], list[ClipRef]]:
    """3-way split where train/val/held-out signer membership is fully explicit.

    Used when `train_signers` and `val_signers` are both present in the split
    JSON (Phase 1 multi-dataset config). Any signer not in any of the three
    lists is dropped (silently) - this is intentional, since the dataset
    loaders write split-disambiguating signer ids like `asl_citizen_train` and
    we don't want spillover from an unexpected cache dir.
    """
    train_set = set(split_cfg.get("train_signers", []))
    val_set = set(split_cfg.get("val_signers", []))
    held_set = set(split_cfg.get("held_out_signers", []))
    train, val, held = [], [], []
    for r in refs:
        if r.signer in held_set:
            held.append(r)
        elif r.signer in val_set:
            val.append(r)
        elif r.signer in train_set:
            train.append(r)
    return train, val, held


def _split_refs_fractional(refs: list[ClipRef], split_cfg: dict
                           ) -> tuple[list[ClipRef], list[ClipRef], list[ClipRef]]:
    """Original 2-way split: held_out_signers + val_fraction carved per-class
    out of the remaining train pool. Backward-compatible default."""
    held = set(split_cfg.get("held_out_signers", []))
    seed = split_cfg.get("random_seed", 42)
    val_frac = split_cfg.get("val_fraction_within_train_signers", 0.15)

    train_pool = [r for r in refs if r.signer not in held]
    val_signer = [r for r in refs if r.signer in held]

    rng = random.Random(seed)
    by_sign: dict[str, list[ClipRef]] = {}
    for r in train_pool:
        by_sign.setdefault(r.sign, []).append(r)
    train, val = [], []
    for sign, items in by_sign.items():
        rng.shuffle(items)
        n_val = max(1, int(len(items) * val_frac)) if len(items) > 1 else 0
        val.extend(items[:n_val])
        train.extend(items[n_val:])
    return train, val, val_signer


def _split_refs(refs: list[ClipRef], split_cfg: dict
                ) -> tuple[list[ClipRef], list[ClipRef], list[ClipRef]]:
    """Return (train, val, val_signer) using whichever schema the split JSON
    declares. Explicit 3-way wins when both train_signers and val_signers are
    present; otherwise we fall back to the original fraction-carve."""
    if split_cfg.get("train_signers") and split_cfg.get("val_signers"):
        return _split_refs_explicit(refs, split_cfg)
    return _split_refs_fractional(refs, split_cfg)


# --------------------------------------------------------------------------- generator

def _gen(refs: list[ClipRef], max_len: int, use_motion_deltas: bool,
         use_acceleration: bool, shuffle: bool, seed: int):
    """Build a closure that yields (features, mask), label tuples.

    When ``shuffle=True`` the refs list is fully shuffled at the top of every
    iteration over the generator (i.e. once per epoch, since
    ``tf.data.Dataset.from_generator`` re-invokes the closure per epoch). This
    is the fix for the multi-dataset training bug where the original pipeline
    iterated refs in cache-then-signer-then-sign order with only a 1024-element
    ``tf.data.shuffle`` buffer, which left contiguous ~70K-clip cache regions
    intact within an epoch and made each batch dominated by a single source's
    single signer's clips.

    ``seed`` lets the caller make the per-epoch shuffle reproducible; it's
    advanced by the iteration count so different epochs see different orders.
    """
    rng = random.Random(seed)
    def _it():
        order = list(refs)
        if shuffle:
            rng.shuffle(order)
        for r in order:
            arr = np.load(r.path)
            feats, mask = pp.preprocess_numpy(
                arr, max_len=max_len, use_motion_deltas=use_motion_deltas,
                use_acceleration=use_acceleration,
            )
            yield (feats, mask), np.int32(r.label)
    return _it


def _resolve_channel_flags(cfg: dict) -> tuple[bool, bool]:
    """Map cfg.data.{use_motion_deltas, use_acceleration, n_channels} -> bools.

    Default behavior backward-compatible with pre-acceleration configs:
    n_channels == 9  -> motion + accel
    n_channels == 6  -> motion only
    n_channels == 3  -> raw
    Explicit cfg.data.use_motion_deltas / use_acceleration override the
    n_channels-derived defaults if set.
    """
    n_ch = cfg["data"]["n_channels"]
    use_motion_deltas = bool(cfg["data"].get("use_motion_deltas", n_ch >= 6))
    use_acceleration = bool(cfg["data"].get("use_acceleration", n_ch == 9))
    return use_motion_deltas, use_acceleration


def _make_element_ds(refs: list[ClipRef], cfg: dict, training: bool,
                     seed: int = 42) -> tf.data.Dataset:
    """Build a per-element (NOT batched) tf.data.Dataset over ``refs``.

    Splitting batching out lets ``build_datasets`` stitch multiple per-source
    element datasets together via ``tf.data.Dataset.sample_from_datasets`` for
    balanced multi-dataset training; batching/prefetching is applied AFTER
    sampling so each batch sees the balanced mix.
    """
    max_len = cfg["data"]["max_len"]
    n_lm = cfg["data"]["n_landmarks"]
    n_ch = cfg["data"]["n_channels"]
    use_motion_deltas, use_acceleration = _resolve_channel_flags(cfg)

    output_signature = (
        (
            tf.TensorSpec(shape=(max_len, n_lm, n_ch), dtype=tf.float32),
            tf.TensorSpec(shape=(max_len,), dtype=tf.bool),
        ),
        tf.TensorSpec(shape=(), dtype=tf.int32),
    )
    ds = tf.data.Dataset.from_generator(
        _gen(refs, max_len, use_motion_deltas, use_acceleration,
             shuffle=training, seed=seed),
        output_signature=output_signature,
    )

    if training:
        aug = build_augment_fn(cfg.get("augment", {}))

        def _aug(xs, y):
            feats, mask = xs
            feats, mask = aug(feats, mask)
            return (feats, mask), y

        ds = ds.map(_aug, num_parallel_calls=tf.data.AUTOTUNE)

    return ds


def _interleave_balanced(by_source: dict[str, list[ClipRef]]):
    """Yield refs in round-robin balanced order across sources.

    Each iteration of the outer loop draws one ref from each currently-active
    source in turn (alphabetical for determinism). When a source is exhausted
    it's dropped from the active set and the round-robin continues with the
    survivors - so early in the epoch every batch sees ~equal contributions
    from all sources, and the tail naturally leans toward whichever sources
    still have refs remaining (typically the largest one, kaggle_islr).

    The caller is responsible for shuffling within each per-source list before
    passing it in (the per-epoch shuffle happens in ``_gen_balanced``).
    """
    iters = {s: iter(by_source[s]) for s in sorted(by_source)}
    active = list(iters)
    while active:
        for s in list(active):
            try:
                yield next(iters[s])
            except StopIteration:
                active.remove(s)


def _gen_balanced(refs_by_source: dict[str, list[ClipRef]], max_len: int,
                  use_motion_deltas: bool, use_acceleration: bool, seed: int):
    """Balanced multi-source generator factory.

    Each epoch:
      1. Shuffle each per-source ref list (different rng per source so they
         don't lock step).
      2. Round-robin interleave the shuffled lists via ``_interleave_balanced``.
      3. Yield ((features, mask), label) for each ref in the interleaved order.

    This is the python-side equivalent of
    ``tf.data.Dataset.sample_from_datasets(per_source_dss, weights=[1/N]*N,
    stop_on_empty_dataset=False)`` but uses a SINGLE ``from_generator`` source
    so the rest of the tf.data pipeline (map + batch + prefetch) sees one
    serial input stream. The multi-generator + ``sample_from_datasets`` path
    we tried first stalled with GPU at 0% for 20+ min on the broad config
    (kaggle's 25x size differential vs the others appears to surface a
    pathological interleave behaviour in TF 2.15); python-side interleaving
    is simpler, deterministic, and matches the proven kaggle_smoke pipeline.
    """
    sources = sorted(refs_by_source)
    rngs = {s: random.Random(seed + i) for i, s in enumerate(sources)}
    def _it():
        shuffled = {s: list(refs_by_source[s]) for s in sources}
        for s in sources:
            rngs[s].shuffle(shuffled[s])
        for r in _interleave_balanced(shuffled):
            arr = np.load(r.path)
            feats, mask = pp.preprocess_numpy(
                arr, max_len=max_len, use_motion_deltas=use_motion_deltas,
                use_acceleration=use_acceleration,
            )
            yield (feats, mask), np.int32(r.label)
    return _it


def _make_balanced_element_ds(refs_by_source: dict[str, list[ClipRef]],
                              cfg: dict, seed: int) -> tf.data.Dataset:
    """Per-element (NOT batched) balanced multi-source training dataset.

    Single ``from_generator`` whose underlying iterator does python-side
    round-robin interleaving across the sources, then standard tf.data map
    for parallel augmentation.
    """
    max_len = cfg["data"]["max_len"]
    n_lm = cfg["data"]["n_landmarks"]
    n_ch = cfg["data"]["n_channels"]
    use_motion_deltas, use_acceleration = _resolve_channel_flags(cfg)

    output_signature = (
        (
            tf.TensorSpec(shape=(max_len, n_lm, n_ch), dtype=tf.float32),
            tf.TensorSpec(shape=(max_len,), dtype=tf.bool),
        ),
        tf.TensorSpec(shape=(), dtype=tf.int32),
    )
    ds = tf.data.Dataset.from_generator(
        _gen_balanced(refs_by_source, max_len, use_motion_deltas,
                      use_acceleration, seed),
        output_signature=output_signature,
    )

    aug = build_augment_fn(cfg.get("augment", {}))

    def _aug(xs, y):
        feats, mask = xs
        feats, mask = aug(feats, mask)
        return (feats, mask), y

    ds = ds.map(_aug, num_parallel_calls=tf.data.AUTOTUNE)
    return ds


def _cutmix_cfg(cfg: dict) -> dict:
    return cfg.get("augment", {}).get("cutmix", {}) or {}


def _one_hot_map(num_classes: int):
    """Map (xs, label_int32) -> (xs, label_one_hot_float32). Used to align
    label dtype/shape between train (which may apply CutMix to produce soft
    labels) and val (always one-hot since the loss/metric is the same)."""
    def _fn(xs, label):
        return xs, tf.one_hot(label, depth=num_classes, dtype=tf.float32)
    return _fn


def _build_train_ds(train_refs: list[ClipRef], cfg: dict, num_classes: int
                    ) -> tuple[tf.data.Dataset, dict]:
    """Build the training dataset with per-source balanced sampling.

    Two element-pipeline paths (same downstream shape):
      * Single source (or all refs share one source, e.g. kaggle_smoke):
        plain pipeline (single ``from_generator`` over python-shuffled refs).
      * Multi-source (broad config): ``_make_balanced_element_ds`` round-robin
        interleaves at the python layer before the single ``from_generator``.

    After batching, if ``cfg.augment.cutmix.enabled`` is True the labels are
    one-hot'd and ``build_batch_cutmix`` is applied. The CutMix stage
    yields soft labels; the same one-hot transform is applied to val/val_signer
    in ``_build_eval_ds`` so the loss/metric (CategoricalCrossentropy +
    CategoricalAccuracy) sees the same shape on both sides. When CutMix is
    disabled we keep the simpler int-label SparseCategoricalCE pipeline.
    """
    seed = int(cfg.get("seed", 42))
    batch = cfg["train"]["batch_size"]

    by_source: dict[str, list[ClipRef]] = {}
    for r in train_refs:
        by_source.setdefault(r.source, []).append(r)

    sources_meta = [
        {"source": s, "n_train": len(rs)} for s, rs in sorted(by_source.items())
    ]

    if len(by_source) <= 1:
        element_ds = _make_element_ds(train_refs, cfg, training=True, seed=seed)
    else:
        element_ds = _make_balanced_element_ds(by_source, cfg, seed=seed)

    train_ds = element_ds.batch(batch, drop_remainder=False)

    cm_cfg = _cutmix_cfg(cfg)
    cutmix_enabled = bool(cm_cfg.get("enabled"))
    if cutmix_enabled:
        train_ds = train_ds.map(_one_hot_map(num_classes),
                                num_parallel_calls=tf.data.AUTOTUNE)
        cm = build_batch_cutmix(
            alpha=float(cm_cfg.get("alpha", 0.3)),
            prob=float(cm_cfg.get("prob", 1.0)),
        )
        train_ds = train_ds.map(cm, num_parallel_calls=tf.data.AUTOTUNE)

    train_ds = train_ds.prefetch(tf.data.AUTOTUNE)
    meta = {
        "sources": sources_meta,
        "balanced": len(by_source) > 1,
        "cutmix_enabled": cutmix_enabled,
    }
    return train_ds, meta


def _build_eval_ds(refs: list[ClipRef], cfg: dict, num_classes: int
                   ) -> tf.data.Dataset:
    """Single one-pass dataset for val / val_signer (no shuffle, no augment).

    Labels one-hot'd to match train when CutMix is enabled (so the same
    compiled loss works on both); kept as int32 otherwise.
    """
    batch = cfg["train"]["batch_size"]
    ds = (_make_element_ds(refs, cfg, training=False)
          .batch(batch, drop_remainder=False))
    if bool(_cutmix_cfg(cfg).get("enabled")):
        ds = ds.map(_one_hot_map(num_classes),
                    num_parallel_calls=tf.data.AUTOTUNE)
    return ds.prefetch(tf.data.AUTOTUNE)


# --------------------------------------------------------------------------- vocab

def _resolve_vocab(cfg: dict, cache_dirs: list[Path]) -> list[str]:
    """Return the vocab list. Three options for ``cfg.data.vocab``:

    * an explicit ``list[str]`` -> used as-is (preserves order; first
      occurrence wins);
    * ``"auto"`` (or ``None``) -> union of each cache_dir's ``vocab.json``,
      preserving first-dir ordering and deduping by string. Lets dataset
      loaders pick their own top-K labels and have the trainer auto-align
      without forking the config's vocab list per dataset;
    * ``{"file": "<path>"}`` -> read a curated ``vocab.json`` (e.g.
      ``data/vocab/tight.json`` produced by ``scripts/curate_vocab.py
      --write-tight-vocab``). Format: ``{"vocab": [...]}`` or a bare list.
      This is the tight-cut path.
    """
    vocab_cfg = cfg["data"].get("vocab")
    if isinstance(vocab_cfg, list):
        return vocab_cfg
    if isinstance(vocab_cfg, dict) and "file" in vocab_cfg:
        vp = Path(vocab_cfg["file"])
        if not vp.exists():
            raise RuntimeError(f"vocab file not found: {vp}")
        data = json.loads(vp.read_text())
        entries = data["vocab"] if isinstance(data, dict) else list(data)
        if not entries:
            raise RuntimeError(f"vocab file {vp} is empty")
        return list(entries)
    if vocab_cfg in ("auto", None):
        unioned: list[str] = []
        seen: set[str] = set()
        missing: list[Path] = []
        for cache_dir in cache_dirs:
            vj = cache_dir / "vocab.json"
            if not vj.exists():
                missing.append(vj)
                continue
            data = json.loads(vj.read_text())
            entries = data["vocab"] if isinstance(data, dict) else list(data)
            for s in entries:
                if s not in seen:
                    seen.add(s)
                    unioned.append(s)
        if not unioned:
            raise RuntimeError(
                "vocab is 'auto' but none of the cache dirs have a vocab.json. "
                f"Looked under: {[str(p) for p in missing]}"
            )
        return unioned
    raise ValueError(
        f"cfg.data.vocab must be a list, 'auto', or {{'file': '...'}}; got {vocab_cfg!r}"
    )


# --------------------------------------------------------------------------- entry point

def build_datasets(cfg: dict) -> dict:
    """Return {'train': ds, 'val': ds, 'val_signer': ds, 'meta': {...}}.

    Training data is per-source balanced (see ``_build_train_ds``); val and
    val_signer are simple one-pass datasets in the natural cache-scan order.
    """
    if cfg["data"].get("use_smoke"):
        cache_dirs = _as_dir_list(cfg["data"]["smoke_dir"])
    else:
        cache_dirs = _as_dir_list(cfg["data"]["cache_dir"])
    splits = _load_split(Path(cfg["data"]["splits_path"]))
    vocab = _resolve_vocab(cfg, cache_dirs)
    refs = _scan_cache(cache_dirs, vocab)
    if not refs:
        raise RuntimeError(
            f"no clips found under {[str(d) for d in cache_dirs]}. "
            "Record some with `make record` or copy a few .npy files into "
            "data/smoke/<signer>/<sign>/."
        )
    train, val, val_signer = _split_refs(refs, splits)
    num_classes = len(vocab)
    train_ds, train_meta = _build_train_ds(train, cfg, num_classes)
    return {
        "train": train_ds,
        "val": _build_eval_ds(val, cfg, num_classes) if val else None,
        "val_signer": _build_eval_ds(val_signer, cfg, num_classes) if val_signer else None,
        "meta": {
            "n_train": len(train),
            "n_val": len(val),
            "n_val_signer": len(val_signer),
            "vocab": vocab,
            "train_sources": train_meta["sources"],
            "train_balanced": train_meta["balanced"],
            "cutmix_enabled": train_meta["cutmix_enabled"],
        },
    }
