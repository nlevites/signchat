"""tf.data pipeline for the hoyso48 1st-place port.

Cache layout (written by ``src/data/kaggle_islr_loader.py``):
    <cache_dir>/<signer_id>/<sign>/*.npy        # arrays of shape (T, 543, 3)

Pipeline shape (matches hoyso48's notebook cell 8 `get_tfrec_dataset`):

    .npy  -> raw (T, 543, 3) np.array
          -> tf.data: yield variable-length tensor
          -> filter_nans_tf: drop all-NaN-reference frames
          -> (training only) augment_fn(x, max_len): aug suite
          -> Preprocess(max_len): -> (T', 6 * NUM_NODES), NaN -> 0
          -> tf.one_hot(label, 250): one-hot label for label-smoothed CE
          -> padded_batch(batch_size, padding_values=PAD=-100, ...)

The Masking layer in the model honors the PAD value so variable-length clips
share a batch correctly.

Module name kept as ``tfrecords`` for backward compatibility with the existing
imports in ``src/train.py``, ``src/eval.py``, etc -- but we read .npy files
not TFRecords. Naming is historical.
"""

from __future__ import annotations

import json
import random
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import numpy as np
import tensorflow as tf

from ..augment import augment_fn
from ..landmarks import CHANNELS, N_TOTAL
from ..preprocessing import PAD, Preprocess, filter_nans_tf


@dataclass
class ClipRef:
    path: Path
    sign: str
    signer: str
    label: int


# --------------------------------------------------------------------------- cache scan

def _as_dir_list(cache_dir) -> list[Path]:
    if isinstance(cache_dir, (list, tuple)):
        return [Path(d) for d in cache_dir]
    return [Path(cache_dir)]


def _scan_cache(cache_dirs: Iterable[Path], vocab: list[str]) -> list[ClipRef]:
    """Walk one or more cache roots and emit a ClipRef per .npy file whose
    sign is in ``vocab``. Refs are deduped by absolute path so overlapping
    caches don't double-count."""
    label_map = {s: i for i, s in enumerate(vocab)}
    seen: set[Path] = set()
    refs: list[ClipRef] = []
    for cache_dir in cache_dirs:
        if not cache_dir.exists():
            continue
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
                        label=label_map[sign_dir.name],
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
    """3-way split: train_signers / val_signers / held_out_signers.

    Used by the kaggle_islr split JSON. Any signer not in any of the three
    lists is silently dropped.
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
    """2-way split: held_out_signers + val_fraction carved per-class from the
    rest. Backward-compatible default."""
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
    if split_cfg.get("train_signers") and split_cfg.get("val_signers"):
        return _split_refs_explicit(refs, split_cfg)
    return _split_refs_fractional(refs, split_cfg)


# --------------------------------------------------------------------------- generator

def _gen(refs: list[ClipRef], shuffle: bool, seed: int):
    """Closure: yield (raw_landmarks, label_int) for each ref.

    Per epoch (each iter of the closure), refs are reshuffled if
    ``shuffle=True``. Output is the raw (T, 543, 3) array straight off disk;
    augmentation + preprocessing happen in tf.data.map afterwards.
    """
    rng = random.Random(seed)

    def _it():
        order = list(refs)
        if shuffle:
            rng.shuffle(order)
        for r in order:
            arr = np.load(r.path).astype(np.float32)
            yield arr, np.int32(r.label)

    return _it


def _make_element_ds(refs: list[ClipRef], cfg: dict, training: bool,
                     seed: int = 42) -> tf.data.Dataset:
    """Per-element (NOT batched) tf.data.Dataset of preprocessed (T', CHANNELS)
    feature tensors + one-hot labels."""
    max_len = int(cfg["data"]["max_len"])
    num_classes = int(cfg["data"]["num_classes"])
    output_signature = (
        tf.TensorSpec(shape=(None, N_TOTAL, 3), dtype=tf.float32),
        tf.TensorSpec(shape=(), dtype=tf.int32),
    )
    ds = tf.data.Dataset.from_generator(
        _gen(refs, shuffle=training, seed=seed),
        output_signature=output_signature,
    )

    preprocess = Preprocess(max_len=max_len)

    def _process(coord, label):
        coord = filter_nans_tf(coord)
        if training:
            coord = augment_fn(coord, max_len=max_len)
        coord = tf.ensure_shape(coord, (None, N_TOTAL, 3))
        feats = preprocess(coord)[0]                              # (T', CHANNELS)
        feats = tf.cast(feats, tf.float32)
        return feats, tf.one_hot(label, depth=num_classes)

    return ds.map(_process, num_parallel_calls=tf.data.AUTOTUNE)


# --------------------------------------------------------------------------- vocab

def _resolve_vocab(cfg: dict, cache_dirs: list[Path]) -> list[str]:
    """Return the vocab list. Three options for ``cfg.data.vocab``:

    * an explicit ``list[str]`` -> used as-is;
    * ``"auto"`` (or ``None``) -> union of each cache_dir's ``vocab.json``;
    * ``{"file": "<path>"}`` -> read a curated vocab.json.
    """
    vocab_cfg = cfg["data"].get("vocab")
    if isinstance(vocab_cfg, list):
        return list(vocab_cfg)
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
    """Return ``{'train': ds, 'val': ds, 'val_signer': ds, 'meta': {...}}``.

    All datasets are batched + prefetched. Train pipeline shuffles at the
    python/per-epoch level (already done by ``_gen(shuffle=True)``) plus a
    smaller in-graph shuffle for batch-level interleaving.
    """
    cache_dirs = _as_dir_list(cfg["data"]["cache_dir"])
    splits = _load_split(Path(cfg["data"]["splits_path"]))
    vocab = _resolve_vocab(cfg, cache_dirs)
    refs = _scan_cache(cache_dirs, vocab)
    if not refs:
        raise RuntimeError(
            f"no clips found under {[str(d) for d in cache_dirs]}. "
            "Run `make pod-kaggle-islr` to populate the cache."
        )
    train, val, val_signer = _split_refs(refs, splits)

    cfg = {**cfg}
    cfg["data"] = {**cfg["data"], "num_classes": len(vocab)}

    seed = int(cfg.get("seed", 42))
    batch = int(cfg["train"]["batch_size"])
    max_len = int(cfg["data"]["max_len"])
    num_classes = len(vocab)

    padded_shapes = (
        tf.TensorShape([max_len, CHANNELS]),
        tf.TensorShape([num_classes]),
    )
    padding_values = (tf.constant(PAD, dtype=tf.float32), tf.constant(0.0, dtype=tf.float32))

    def _pad(ds: tf.data.Dataset, drop_remainder: bool) -> tf.data.Dataset:
        return ds.padded_batch(
            batch, padding_values=padding_values, padded_shapes=padded_shapes,
            drop_remainder=drop_remainder,
        ).prefetch(tf.data.AUTOTUNE)

    train_ds = _make_element_ds(train, cfg, training=True, seed=seed)
    train_ds = _pad(train_ds, drop_remainder=True)

    val_ds = None
    if val:
        val_ds = _pad(_make_element_ds(val, cfg, training=False, seed=seed), drop_remainder=False)
    val_signer_ds = None
    if val_signer:
        val_signer_ds = _pad(_make_element_ds(val_signer, cfg, training=False, seed=seed),
                             drop_remainder=False)

    return {
        "train": train_ds,
        "val": val_ds,
        "val_signer": val_signer_ds,
        "meta": {
            "n_train": len(train),
            "n_val": len(val),
            "n_val_signer": len(val_signer),
            "vocab": vocab,
            "num_classes": num_classes,
            "max_len": max_len,
        },
    }
