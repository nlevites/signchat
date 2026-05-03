"""Evaluate a checkpoint on val_signer (held-out signers).

Usage:
    python -m src.eval --checkpoint pretrained/<run_name>/
    python -m src.eval --checkpoint pretrained/phase1_kaggle/ \
        --config configs/pretrain_phase1_kaggle.yaml \
        --split held_out

Computes top-1 + top-5 accuracy on the chosen split. Single-tensor I/O matching
the hoyso48 1st-place port: model takes (B, max_len, CHANNELS) with PAD=-100
masking; no separate `mask` tensor.
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
from .landmarks import CHANNELS
from .model import get_model


def _load_sidecar(ckpt_dir: Path) -> dict | None:
    sidecar = ckpt_dir / "vocab.json"
    if not sidecar.exists():
        return None
    return json.loads(sidecar.read_text())


def _apply_sidecar(cfg: dict, sc: dict) -> None:
    """Override data + model shape from the sidecar so the rebuilt model
    matches the checkpoint exactly."""
    sc_data = sc.get("data", {})
    sc_model = sc.get("model", {})
    if "max_len" in sc_data:
        cfg["data"]["max_len"] = int(sc_data["max_len"])
    if "vocab" in sc:
        cfg["data"]["vocab"] = list(sc["vocab"])
    for key in ("dim", "kernel_size", "transformer_expand", "conv_drop", "late_drop"):
        if key in sc_model:
            cfg["model"][key] = sc_model[key]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True,
                        help="path to pretrained/<run>/ or checkpoints/<run>/")
    parser.add_argument("--config", default=None,
                        help="config; defaults to configs/pretrain_phase1_kaggle.yaml")
    parser.add_argument("--split", default="auto",
                        choices=("auto", "val_signer", "val", "held_out"),
                        help="which split to evaluate (default 'auto': val_signer if "
                             "present else val)")
    args = parser.parse_args()

    ckpt_dir = Path(args.checkpoint)
    if not ckpt_dir.exists():
        raise FileNotFoundError(f"no such directory: {ckpt_dir}")

    cfg = load_config(args.config or "configs/pretrain_phase1_kaggle.yaml")
    sidecar = _load_sidecar(ckpt_dir)
    if sidecar is not None:
        _apply_sidecar(cfg, sidecar)
        print(f"[eval] applied sidecar from {ckpt_dir}/vocab.json "
              f"(vocab={len(sidecar.get('vocab', []))})")

    datasets = build_datasets(cfg)
    split = args.split
    if split == "auto":
        split = "val_signer" if datasets.get("val_signer") is not None else "val"
    elif split == "held_out":
        split = "val_signer"

    ds = datasets.get(split)
    if ds is None:
        raise RuntimeError(
            f"no clips for split {split!r}. Check {cfg['data']['splits_path']} "
            f"signer ids match the cache layout under {cfg['data']['cache_dir']}."
        )

    num_classes = datasets["meta"]["num_classes"]
    max_len = datasets["meta"]["max_len"]
    model_cfg = cfg["model"]
    model = get_model(
        num_classes=num_classes, max_len=max_len, channels=CHANNELS,
        dim=int(model_cfg["dim"]), dropout_step=0,
        kernel_size=int(model_cfg.get("kernel_size", 17)),
        conv_drop=0.0,                              # disable dropout for eval
        transformer_expand=int(model_cfg.get("transformer_expand", 2)),
        late_drop=0.0,
    )

    weights_path = ckpt_dir / "best.weights.h5"
    if not weights_path.exists():
        weights_path = ckpt_dir / "last.weights.h5"
    if weights_path.exists():
        model.load_weights(str(weights_path))
        print(f"[eval] loaded weights from {weights_path}")
    else:
        sm = ckpt_dir / "saved_model"
        if sm.exists():
            model = tf.keras.models.load_model(sm)
            print(f"[eval] loaded SavedModel from {sm}")
        else:
            raise FileNotFoundError(
                f"no best.weights.h5, last.weights.h5, or saved_model/ in {ckpt_dir}"
            )

    t0 = time.time()
    n_correct_1 = 0
    n_correct_5 = 0
    n_total = 0
    for feats, labels in ds:
        logits = model(feats, training=False).numpy()
        labels_np = labels.numpy()
        if labels_np.ndim == 2:
            labels_np = labels_np.argmax(axis=-1)
        labels_np = labels_np.astype(np.int32)
        # Top-1.
        preds_1 = np.argmax(logits, axis=-1).astype(np.int32)
        n_correct_1 += int(np.sum(preds_1 == labels_np))
        # Top-5.
        preds_5 = np.argpartition(-logits, kth=5, axis=-1)[:, :5]
        n_correct_5 += int(np.sum(np.any(preds_5 == labels_np[:, None], axis=-1)))
        n_total += int(labels_np.shape[0])
    elapsed = time.time() - t0

    top1 = n_correct_1 / max(n_total, 1)
    top5 = n_correct_5 / max(n_total, 1)
    print(f"[eval] checkpoint={ckpt_dir.name}  split={split}  n={n_total}")
    print(f"[eval]   top1={top1:.4f}  top5={top5:.4f}  elapsed={elapsed:.1f}s")


if __name__ == "__main__":
    main()
