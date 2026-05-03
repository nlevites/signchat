"""Fit a single scalar temperature T on val_signer; write temperature.json
next to the checkpoint.

Why this exists: cross-entropy with label_smoothing=0.1 (our default) plus
Conformer training reliably produces over- or under-confident softmax outputs.
The downstream LLM consumer in the contract layer (src/contract.py +
src/llm_bridge.py) reads `prob` as a meaningful "how confident is the model";
calibration ensures `prob=0.7` actually means the model is right ~70% of the
time.

Usage:
    python -m src.calibrate --checkpoint pretrained/phase1_kaggle/
    python -m src.calibrate --checkpoint pretrained/phase1_broad/

The checkpoint dir MUST contain a vocab.json sidecar (same one realtime_demo
expects). The script:
  1. Builds the model from the sidecar.
  2. Loads best.weights.h5.
  3. Iterates the val_signer split (or val if val_signer is empty), collecting
     LOGITS (not softmaxed probs) and labels.
  4. Optimizes a scalar T in [0.1, 5.0] minimizing
         NLL = -(1/N) sum_i log softmax(z_i / T)[y_i]
     via scipy.optimize.minimize_scalar (Brent's method; ~30 evaluations).
  5. Writes ``temperature.json`` alongside the checkpoint with:
         {"T": <fitted>, "fit_nll": <post-fit>, "pre_fit_nll": <T=1>,
          "n_samples": <N>, "split": "val_signer" | "val", "ece_pre": <>,
          "ece_post": <>}
  6. Prints a summary line.

Reliability note: temperature scaling preserves argmax (T>0 monotone), so
top-1 accuracy is unchanged. Only the calibration of `max_prob` shifts.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import numpy as np


def _load_sidecar(ckpt_dir: Path) -> dict:
    sidecar = ckpt_dir / "vocab.json"
    if not sidecar.exists():
        sys.exit(
            f"ERROR: no vocab.json sidecar at {sidecar}.\n"
            "Calibration requires the sidecar to (a) re-build the model "
            "architecture exactly and (b) match the data pipeline's vocab. "
            "Re-train with the current src/train.py to produce one."
        )
    sc = json.loads(sidecar.read_text())
    for k in ("vocab", "n_classes", "data", "model"):
        if k not in sc:
            sys.exit(f"ERROR: vocab sidecar at {sidecar} missing key {k!r}")
    return sc


def _build_model_from_sidecar(sc: dict):
    """Builds a TF model from the sidecar metadata. TF imported lazily so the
    pure-numpy math helpers below can be unit-tested without TF installed."""
    import tensorflow as tf  # noqa: F401  (used by build_classifier)
    from .model import build_classifier
    m = sc["model"]
    d = sc["data"]
    return build_classifier(
        num_classes=int(sc["n_classes"]),
        name=m["name"],
        max_len=int(d["max_len"]),
        n_landmarks=int(d["n_landmarks"]),
        n_channels=int(d.get("n_channels", 6)),
        dim=int(m["dim"]),
        n_blocks=int(m.get("n_blocks", 4)),
        n_heads=int(m.get("n_heads", 4)),
        conv_kernel=int(m.get("conv_kernel", 17)),
        ffn_expansion=int(m.get("ffn_expansion", 4)),
        dropout=0.0,
    )


def _make_eval_cfg(sc: dict, base_config_path: str) -> dict:
    """Build a config dict that matches the sidecar's data shape but uses the
    base config for the data loader's cache_dir/splits. We default to
    configs/base.yaml + override the data shape from the sidecar so we don't
    have to know which Phase 1 config trained the checkpoint."""
    from .config import load_config
    cfg = load_config(base_config_path)
    cfg["data"]["max_len"] = int(sc["data"]["max_len"])
    cfg["data"]["n_landmarks"] = int(sc["data"]["n_landmarks"])
    cfg["data"]["n_channels"] = int(sc["data"].get("n_channels", 6))
    cfg["data"]["use_motion_deltas"] = bool(
        sc["data"].get("use_motion_deltas", cfg["data"]["n_channels"] >= 6))
    cfg["data"]["use_acceleration"] = bool(
        sc["data"].get("use_acceleration", cfg["data"]["n_channels"] == 9))
    cfg["data"]["vocab"] = list(sc["vocab"])
    return cfg


def _gather_logits(model, ds) -> tuple[np.ndarray, np.ndarray]:
    """Iterate the dataset; return (logits NxC, labels N). TF assumed loaded.

    When CutMix is enabled in the training config, ``_build_eval_ds`` in
    ``src/data/tfrecords.py`` one-hots the eval labels so train + val share
    the same compiled CategoricalCE surface. Calibration NLL/ECE math
    expects integer class ids, so collapse one-hot rows to argmax here.
    """
    all_logits: list[np.ndarray] = []
    all_labels: list[np.ndarray] = []
    for (feats, mask), labels in ds:
        logits = model([feats, mask], training=False).numpy()
        labels_np = labels.numpy()
        if labels_np.ndim == 2:
            labels_np = labels_np.argmax(axis=-1).astype(np.int32)
        all_logits.append(logits)
        all_labels.append(labels_np)
    if not all_logits:
        return (np.zeros((0, 0), dtype=np.float32), np.zeros((0,), dtype=np.int32))
    return (np.concatenate(all_logits, axis=0).astype(np.float32),
            np.concatenate(all_labels, axis=0).astype(np.int32))


def _nll_at_temperature(logits: np.ndarray, labels: np.ndarray, T: float) -> float:
    """Mean negative log-likelihood of softmax(logits / T) at the true class."""
    z = logits / max(T, 1e-6)
    z = z - z.max(axis=-1, keepdims=True)
    log_probs = z - np.log(np.exp(z).sum(axis=-1, keepdims=True))
    n = labels.shape[0]
    return float(-log_probs[np.arange(n), labels].mean())


def _golden_section(f, lo: float, hi: float, tol: float = 1e-3,
                     max_iter: int = 100) -> tuple[float, float]:
    """Minimize unimodal f on [lo, hi] via golden-section search.

    Returns (x_min, f(x_min)). Falls back here when scipy isn't available;
    convergence is well-defined for the (convex-in-log-T) NLL surface
    temperature scaling produces.
    """
    phi = (np.sqrt(5) - 1) / 2  # golden ratio reciprocal ~0.618
    a, b = lo, hi
    c = b - phi * (b - a)
    d = a + phi * (b - a)
    fc = f(c)
    fd = f(d)
    for _ in range(max_iter):
        if abs(b - a) < tol:
            break
        if fc < fd:
            b, d, fd = d, c, fc
            c = b - phi * (b - a)
            fc = f(c)
        else:
            a, c, fc = c, d, fd
            d = a + phi * (b - a)
            fd = f(d)
    x = 0.5 * (a + b)
    return x, f(x)


def _expected_calibration_error(logits: np.ndarray, labels: np.ndarray,
                                  T: float, n_bins: int = 15) -> float:
    """Standard ECE: bucket predictions by max-softmax confidence; weighted
    average of |accuracy - confidence| per bucket. Lower is better."""
    z = logits / max(T, 1e-6)
    z = z - z.max(axis=-1, keepdims=True)
    p = np.exp(z) / np.exp(z).sum(axis=-1, keepdims=True)
    conf = p.max(axis=-1)
    pred = p.argmax(axis=-1)
    correct = (pred == labels).astype(np.float32)
    bins = np.linspace(0, 1, n_bins + 1)
    ece = 0.0
    n = len(labels)
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (conf > lo) & (conf <= hi)
        if mask.any():
            avg_conf = conf[mask].mean()
            avg_acc = correct[mask].mean()
            ece += (mask.sum() / n) * abs(avg_acc - avg_conf)
    return float(ece)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True,
                        help="path to the checkpoint dir (e.g. "
                             "pretrained/phase1_kaggle/)")
    parser.add_argument("--base-config", default="configs/base.yaml",
                        help="config to use for the data loader (cache_dir, "
                             "splits_path); the sidecar overrides data shape "
                             "so vocab matches exactly. Default: configs/base.yaml")
    parser.add_argument("--split", default=None,
                        choices=("val_signer", "val", "auto"),
                        help="which split to fit on (default 'auto': prefer "
                             "val_signer, fall back to val)")
    parser.add_argument("--T-min", type=float, default=0.1,
                        help="minimum temperature to search (default 0.1)")
    parser.add_argument("--T-max", type=float, default=5.0,
                        help="maximum temperature to search (default 5.0)")
    parser.add_argument("--out-name", default="temperature.json",
                        help="filename to write next to the checkpoint "
                             "(default temperature.json)")
    parser.add_argument("--dry-run", action="store_true",
                        help="don't write temperature.json; just print the result")
    args = parser.parse_args()

    ckpt_dir = Path(args.checkpoint)
    if not ckpt_dir.exists():
        sys.exit(f"ERROR: no such directory: {ckpt_dir}")

    # Disable oneDNN BEFORE importing TF (matches src/train.py).
    os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
    from .data.tfrecords import build_datasets

    print(f"[calibrate] loading sidecar from {ckpt_dir}/vocab.json")
    sc = _load_sidecar(ckpt_dir)
    cfg = _make_eval_cfg(sc, args.base_config)

    print(f"[calibrate] building data pipeline (vocab size = {sc['n_classes']})")
    datasets = build_datasets(cfg)
    split_name = args.split or "auto"
    if split_name in (None, "auto"):
        split_name = "val_signer" if datasets.get("val_signer") is not None else "val"
    ds = datasets.get(split_name)
    if ds is None:
        sys.exit(
            f"ERROR: split {split_name!r} is empty. Check that "
            f"{cfg['data']['splits_path']} lists signer ids that match the "
            f"cache layout under {cfg['data']['cache_dir']}."
        )
    print(f"[calibrate] using split: {split_name}")

    print(f"[calibrate] building model from sidecar")
    model = _build_model_from_sidecar(sc)
    weights = ckpt_dir / "best.weights.h5"
    if not weights.exists():
        sys.exit(f"ERROR: no best.weights.h5 in {ckpt_dir}")
    model.load_weights(str(weights), by_name=True, skip_mismatch=False)
    print(f"[calibrate] loaded weights")

    t0 = time.time()
    print(f"[calibrate] gathering logits...")
    logits, labels = _gather_logits(model, ds)
    elapsed = time.time() - t0
    print(f"[calibrate] gathered {len(labels)} samples in {elapsed:.1f}s")
    if len(labels) == 0:
        sys.exit(f"ERROR: zero samples in split {split_name!r}; nothing to fit on.")

    pre_nll = _nll_at_temperature(logits, labels, T=1.0)
    pre_ece = _expected_calibration_error(logits, labels, T=1.0)
    print(f"[calibrate] pre-fit:  NLL={pre_nll:.4f}  ECE={pre_ece:.4f}  (T=1.0)")

    # Optimize T in [T_min, T_max]. Prefer scipy (Brent's method); fall back to
    # a numpy-only golden-section search so calibration doesn't require an
    # extra dependency. Both are unimodal-safe; NLL(T) for temperature scaling
    # is convex in log T (well-known property), so either converges in ~30 evals.
    try:
        from scipy.optimize import minimize_scalar
        res = minimize_scalar(
            fun=lambda T: _nll_at_temperature(logits, labels, T),
            bounds=(args.T_min, args.T_max),
            method="bounded",
            options={"xatol": 1e-3},
        )
        T = float(res.x)
        post_nll = float(res.fun)
        print(f"[calibrate] optimizer: scipy.minimize_scalar (Brent, bounded)")
    except ImportError:
        T, post_nll = _golden_section(
            f=lambda T: _nll_at_temperature(logits, labels, T),
            lo=args.T_min, hi=args.T_max, tol=1e-3,
        )
        print(f"[calibrate] optimizer: numpy golden-section "
              f"(scipy not installed; behavior identical for our convex NLL)")
    post_ece = _expected_calibration_error(logits, labels, T=T)
    print(f"[calibrate] post-fit: NLL={post_nll:.4f}  ECE={post_ece:.4f}  (T={T:.4f})")
    print(f"[calibrate] NLL improvement: {pre_nll - post_nll:+.4f} "
          f"(ECE: {pre_ece - post_ece:+.4f})")

    payload = {
        "T": T,
        "fit_nll": post_nll,
        "pre_fit_nll": pre_nll,
        "ece_pre": pre_ece,
        "ece_post": post_ece,
        "n_samples": int(len(labels)),
        "split": split_name,
        "T_search_range": [args.T_min, args.T_max],
        "checkpoint": str(ckpt_dir),
        "_note": (
            "Apply at inference: divide logits by T BEFORE softmax. "
            "Preserves argmax (top-1 acc unchanged), only re-scales confidence. "
            "Loaded by src/realtime_demo.py when configs/contract.yaml has "
            "calibration.apply: true."
        ),
    }
    if args.dry_run:
        print(f"[calibrate] --dry-run: skipping write")
        print(json.dumps(payload, indent=2))
        return

    out = ckpt_dir / args.out_name
    out.write_text(json.dumps(payload, indent=2) + "\n")
    print(f"[calibrate] wrote {out}")


if __name__ == "__main__":
    main()
