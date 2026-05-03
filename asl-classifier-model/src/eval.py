"""Evaluate a checkpoint on the held-out signer set.

Usage:
    python -m src.eval --checkpoint pretrained/<run_name>/
    python -m src.eval --checkpoint pretrained/phase1_kaggle/ \
        --config configs/pretrain_phase1_kaggle.yaml

Prints a single line summary and returns top-1 accuracy on the held-out
signer clips. Targets <60s wall time so it fits inside the inner iteration
loop. Defaults to ``configs/base.yaml`` for the data pipeline; when the
checkpoint dir contains a ``vocab.json`` sidecar (written by ``src/train.py``)
its data shape (``max_len``, ``n_landmarks``, ``n_channels``) overrides the
config so 9-channel PopSign checkpoints don't fall back to the legacy
6-channel default.
"""

from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import tensorflow as tf

from .config import load_config
from .data.tfrecords import build_datasets
from .model import build_classifier


def _load_sidecar(ckpt_dir: Path) -> dict | None:
    sidecar = ckpt_dir / "vocab.json"
    if not sidecar.exists():
        return None
    return json.loads(sidecar.read_text())


def _apply_sidecar(cfg: dict, sc: dict) -> None:
    """Override the data + model shape from the sidecar so the rebuilt model
    matches the checkpoint exactly. Vocab is also forced to the sidecar's
    ordering so label indices line up."""
    sc_data = sc.get("data", {})
    sc_model = sc.get("model", {})
    for key in ("max_len", "n_landmarks", "n_channels"):
        if key in sc_data:
            cfg["data"][key] = sc_data[key]
    if "use_motion_deltas" in sc_data:
        cfg["data"]["use_motion_deltas"] = bool(sc_data["use_motion_deltas"])
    if "use_acceleration" in sc_data:
        cfg["data"]["use_acceleration"] = bool(sc_data["use_acceleration"])
    if "vocab" in sc:
        cfg["data"]["vocab"] = list(sc["vocab"])
    for key in ("name", "dim", "n_blocks", "n_heads", "conv_kernel", "ffn_expansion"):
        if key in sc_model:
            cfg["model"][key] = sc_model[key]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True,
                        help="path to checkpoints/<run_name>/ or "
                             "pretrained/<run_name>/ directory")
    parser.add_argument("--config", default=None,
                        help="config to use; defaults to configs/base.yaml. "
                             "When the checkpoint has a vocab.json sidecar its "
                             "data/model shape overrides the config.")
    parser.add_argument("--split", default="auto",
                        choices=("auto", "val_signer", "val"),
                        help="which split to evaluate (default 'auto': prefer "
                             "val_signer, fall back to val)")
    args = parser.parse_args()

    ckpt_dir = Path(args.checkpoint)
    if not ckpt_dir.exists():
        raise FileNotFoundError(f"no such directory: {ckpt_dir}")

    cfg = load_config(args.config or "configs/base.yaml")
    sidecar = _load_sidecar(ckpt_dir)
    if sidecar is not None:
        _apply_sidecar(cfg, sidecar)
        print(f"[eval] applied sidecar from {ckpt_dir}/vocab.json "
              f"(n_channels={cfg['data']['n_channels']}, "
              f"vocab={len(sidecar.get('vocab', []))})")

    datasets = build_datasets(cfg)
    split = args.split
    if split == "auto":
        split = "val_signer" if datasets.get("val_signer") is not None else "val"
    ds = datasets.get(split)
    if ds is None:
        raise RuntimeError(
            f"no clips for split {split!r}. Check {cfg['data']['splits_path']} "
            f"signer ids match the cache layout under {cfg['data']['cache_dir']}."
        )

    num_classes = len(datasets["meta"]["vocab"])
    model = build_classifier(
        num_classes=num_classes,
        name=cfg["model"]["name"],
        max_len=cfg["data"]["max_len"],
        n_landmarks=cfg["data"]["n_landmarks"],
        n_channels=cfg["data"].get("n_channels", 6),
        dim=cfg["model"]["dim"],
        n_blocks=cfg["model"].get("n_blocks", 4),
        n_heads=cfg["model"].get("n_heads", 4),
        conv_kernel=cfg["model"].get("conv_kernel", 17),
        ffn_expansion=cfg["model"].get("ffn_expansion", 4),
        dropout=0.0,
    )

    weights_path = ckpt_dir / "best.weights.h5"
    if weights_path.exists():
        model.load_weights(str(weights_path))
    else:
        sm = ckpt_dir / "saved_model"
        if sm.exists():
            model = tf.keras.models.load_model(sm)
        else:
            raise FileNotFoundError(f"no best.weights.h5 or saved_model/ in {ckpt_dir}")

    t0 = time.time()
    correct = 0
    total = 0
    for (feats, mask), labels in ds:
        logits = model([feats, mask], training=False)
        preds = tf.argmax(logits, axis=-1, output_type=tf.int32).numpy()
        # When CutMix is enabled in the config, _build_eval_ds emits one-hot
        # labels (so train + eval share the same compiled CategoricalCE
        # surface). Convert back to integer class ids for the comparison.
        labels_np = labels.numpy()
        if labels_np.ndim == 2:
            labels_np = labels_np.argmax(axis=-1).astype(np.int32)
        correct += int(np.sum(preds == labels_np))
        total += int(labels_np.shape[0])
    elapsed = time.time() - t0

    acc = correct / max(total, 1)
    print(f"[eval] checkpoint={ckpt_dir.name}  split={split}  n={total}  "
          f"top1={acc:.4f}  elapsed={elapsed:.1f}s")


if __name__ == "__main__":
    main()
