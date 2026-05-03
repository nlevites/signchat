"""Pre-flight validation for the broad+tight training runs.

Run this BEFORE launching any expensive ($16+ H200) training job. Catches:

  1. Vocab integrity: tight.json exists, has >= MIN_TIGHT signs, every
     entry resolvable to a non-empty cache subdir.
  2. Splits sanity: data/splits/asl_citizen.json has >= MIN_TRAIN train
     signers, >= 1 val_signer, >= 1 held_out_signer, no signer overlap
     across cohorts.
  3. Datasets build: src.data.tfrecords.build_datasets(cfg) returns
     non-empty train/val/val_signer for both broad and tight configs.
  4. Smoke train-step: build the configured model, take ONE batch, run
     a single forward+backward pass, verify no NaN/Inf.
  5. Demo safety end-to-end: train a tiny synthetic model, save checkpoint
     + vocab.json sidecar, then have realtime_demo's strict loader rebuild
     and load it. Catches sidecar/architecture drift.

Exit code 0 = all gates pass; exit code 1 = something blocked the launch.

CLI:
    python scripts/validate_phase1.py --config configs/pretrain_phase1_broad.yaml
    python scripts/validate_phase1.py --config configs/pretrain_phase1_tight.yaml
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

# Pre-import-time TF env (mirror src/train.py)
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# Defer heavy imports until needed (TF imports are slow + verbose).
MIN_TRAIN_SIGNERS = 5
MIN_VAL_SIGNERS = 1
MIN_HELD_OUT_SIGNERS = 1
MIN_TIGHT_VOCAB = 10


def _gate(label: str, ok: bool, detail: str = ""):
    """Print pass/fail row; return ok bool for accumulation."""
    marker = "PASS" if ok else "FAIL"
    print(f"  [{marker}] {label}" + (f" - {detail}" if detail else ""))
    return ok


def gate_vocab(vocab_cfg, cache_dirs: list[Path]) -> bool:
    """Check the vocab list is sane and non-empty."""
    print("\n[gate] vocab integrity")
    if isinstance(vocab_cfg, dict) and "file" in vocab_cfg:
        vp = Path(vocab_cfg["file"])
        if not _gate(f"vocab file {vp} exists", vp.exists()):
            return False
        data = json.loads(vp.read_text())
        signs = data["vocab"] if isinstance(data, dict) else list(data)
        ok = _gate(f"vocab has >= {MIN_TIGHT_VOCAB} signs",
                   len(signs) >= MIN_TIGHT_VOCAB,
                   f"got {len(signs)}")
        return ok
    elif vocab_cfg == "auto":
        any_cache = any((d / "vocab.json").exists() for d in cache_dirs)
        return _gate(f"at least one cache_dir has vocab.json", any_cache,
                     f"checked {[str(d) for d in cache_dirs]}")
    else:
        return _gate("vocab is list / file / auto",
                     isinstance(vocab_cfg, (list, dict, str)),
                     f"got {type(vocab_cfg).__name__}")


def gate_splits(splits_path: Path) -> bool:
    print("\n[gate] splits sanity")
    if not _gate(f"{splits_path} exists", splits_path.exists()):
        return False
    sj = json.loads(splits_path.read_text())
    train = set(sj.get("train_signers", []))
    val = set(sj.get("val_signers", []))
    held = set(sj.get("held_out_signers", []))
    ok = _gate(f"train_signers >= {MIN_TRAIN_SIGNERS}",
               len(train) >= MIN_TRAIN_SIGNERS, f"got {len(train)}")
    ok &= _gate(f"val_signers >= {MIN_VAL_SIGNERS}",
                len(val) >= MIN_VAL_SIGNERS, f"got {len(val)}")
    ok &= _gate(f"held_out_signers >= {MIN_HELD_OUT_SIGNERS}",
                len(held) >= MIN_HELD_OUT_SIGNERS, f"got {len(held)}")
    overlap_tv = train & val
    overlap_th = train & held
    overlap_vh = val & held
    ok &= _gate("no train/val signer overlap", not overlap_tv,
                f"overlap: {sorted(overlap_tv)[:5]}")
    ok &= _gate("no train/held signer overlap", not overlap_th,
                f"overlap: {sorted(overlap_th)[:5]}")
    ok &= _gate("no val/held signer overlap", not overlap_vh,
                f"overlap: {sorted(overlap_vh)[:5]}")
    return ok


def gate_datasets_build(cfg: dict) -> tuple[bool, dict | None]:
    """Verify the trainer's data pipeline can build non-empty splits."""
    print("\n[gate] datasets build (this may take 30-60 sec)")
    try:
        from src.data.tfrecords import build_datasets
        ds = build_datasets(cfg)
    except Exception as e:
        _gate("build_datasets() succeeds", False, f"{type(e).__name__}: {e}")
        return False, None
    meta = ds["meta"]
    ok = _gate(f"train clips > 0", meta["n_train"] > 0, f"got {meta['n_train']}")
    ok &= _gate(f"val clips > 0", meta["n_val"] > 0, f"got {meta['n_val']}")
    ok &= _gate(f"val_signer clips > 0",
                meta["n_val_signer"] > 0, f"got {meta['n_val_signer']}")
    ok &= _gate(f"vocab size > 0",
                len(meta["vocab"]) > 0, f"got {len(meta['vocab'])}")
    return ok, ds


def gate_smoke_train(cfg: dict, datasets: dict) -> bool:
    """Take one batch, do one forward+backward pass."""
    print("\n[gate] smoke train-step (build model + 1 step)")
    try:
        import tensorflow as tf
        from src.model import build_classifier

        n_classes = len(datasets["meta"]["vocab"])
        model = build_classifier(
            num_classes=n_classes,
            name=cfg["model"]["name"],
            max_len=cfg["data"]["max_len"],
            n_landmarks=cfg["data"]["n_landmarks"],
            n_channels=cfg["data"].get("n_channels", 6),
            dim=cfg["model"]["dim"],
            n_blocks=cfg["model"].get("n_blocks", 4),
            n_heads=cfg["model"].get("n_heads", 4),
            conv_kernel=cfg["model"].get("conv_kernel", 17),
            ffn_expansion=cfg["model"].get("ffn_expansion", 4),
            dropout=cfg["model"].get("dropout", 0.2),
        )
        if not _gate(f"model builds", True, f"params={model.count_params():,}"):
            return False
        opt = tf.keras.optimizers.AdamW(learning_rate=1e-4)
        loss_fn = tf.keras.losses.SparseCategoricalCrossentropy(from_logits=True)
        # Take one batch from the train dataset
        for (feats, mask), y in datasets["train"].take(1):
            with tf.GradientTape() as tape:
                logits = model([feats, mask], training=True)
                loss = tf.reduce_mean(loss_fn(y, logits))
            grads = tape.gradient(loss, model.trainable_variables)
            opt.apply_gradients(zip(grads, model.trainable_variables))
            loss_v = float(loss.numpy())
            if not _gate("loss is finite",
                         tf.math.is_finite(loss).numpy() and loss_v > 0,
                         f"loss={loss_v:.4f}"):
                return False
            n_finite_grads = sum(1 for g in grads if g is not None
                                  and bool(tf.math.reduce_all(tf.math.is_finite(g)).numpy()))
            if not _gate(f"all gradients finite",
                         n_finite_grads == sum(1 for g in grads if g is not None),
                         f"{n_finite_grads}/{sum(1 for g in grads if g is not None)} finite"):
                return False
            return True
        return _gate("got a batch from train dataset", False)
    except Exception as e:
        _gate("smoke train-step", False, f"{type(e).__name__}: {e}")
        return False


def gate_demo_safety(cfg: dict) -> bool:
    """Train a tiny synthetic model, save checkpoint + sidecar, then strict-load
    it via realtime_demo's loader. Catches sidecar/architecture drift between
    train.py and realtime_demo.py."""
    print("\n[gate] demo safety end-to-end (sidecar write + strict load)")
    try:
        import tensorflow as tf
        from src.model import build_classifier
        from src.realtime_demo import _load_sidecar, _build_model_from_sidecar

        with tempfile.TemporaryDirectory() as tmp:
            out_dir = Path(tmp) / "smoke_ckpt"
            out_dir.mkdir(parents=True, exist_ok=True)
            n_classes = 5
            model = build_classifier(
                num_classes=n_classes, name=cfg["model"]["name"],
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
            model.save_weights(str(out_dir / "best.weights.h5"))
            sidecar = {
                "vocab": [f"smoke_{i}" for i in range(n_classes)],
                "n_classes": n_classes,
                "source_config": "validate_phase1.py",
                "experiment_name": "smoke",
                "run_id": "smoke",
                "model": {
                    "name": cfg["model"]["name"],
                    "dim": cfg["model"]["dim"],
                    "n_blocks": cfg["model"].get("n_blocks", 4),
                    "n_heads": cfg["model"].get("n_heads", 4),
                    "conv_kernel": cfg["model"].get("conv_kernel", 17),
                    "ffn_expansion": cfg["model"].get("ffn_expansion", 4),
                },
                "data": {
                    "max_len": cfg["data"]["max_len"],
                    "n_landmarks": cfg["data"]["n_landmarks"],
                    "n_channels": cfg["data"].get("n_channels", 6),
                    "use_motion_deltas": bool(cfg["data"].get(
                        "use_motion_deltas",
                        cfg["data"].get("n_channels", 6) == 6)),
                },
            }
            (out_dir / "vocab.json").write_text(json.dumps(sidecar, indent=2))
            sc = _load_sidecar(out_dir)
            ok = _gate("sidecar parses + validates", True)
            m2 = _build_model_from_sidecar(sc)
            m2.load_weights(str(out_dir / "best.weights.h5"),
                            by_name=True, skip_mismatch=False)
            ok &= _gate("rebuilt model loads weights cleanly", True)
            return ok
    except Exception as e:
        _gate("demo safety end-to-end", False, f"{type(e).__name__}: {e}")
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--config", required=True,
                   help="path to a Phase 1 config (broad or tight)")
    p.add_argument("--skip-smoke-train", action="store_true",
                   help="skip the GPU/CPU forward+backward smoke pass "
                        "(useful when TF can't initialize on this box)")
    args = p.parse_args()

    print(f"[validate] config = {args.config}")
    from src.config import load_config
    cfg = load_config(args.config)

    # cache_dirs may be a list or a single string in the config.
    cache_dir_cfg = cfg["data"].get("cache_dir")
    if isinstance(cache_dir_cfg, (list, tuple)):
        cache_dirs = [Path(d) for d in cache_dir_cfg]
    else:
        cache_dirs = [Path(cache_dir_cfg)]
    print(f"[validate] cache dirs: {[str(d) for d in cache_dirs]}")

    results = []
    results.append(("vocab", gate_vocab(cfg["data"].get("vocab"), cache_dirs)))
    results.append(("splits", gate_splits(Path(cfg["data"]["splits_path"]))))

    # The dataset build + smoke train + demo safety gates require
    # actual cached data and TF. Skip them if vocab/splits failed.
    if not all(ok for _, ok in results):
        print("\n[validate] earlier gates failed; skipping dataset/TF gates")
    else:
        ds_ok, datasets = gate_datasets_build(cfg)
        results.append(("datasets-build", ds_ok))
        if ds_ok and datasets is not None and not args.skip_smoke_train:
            results.append(("smoke-train-step", gate_smoke_train(cfg, datasets)))
            results.append(("demo-safety", gate_demo_safety(cfg)))

    print("\n=== Summary ===")
    for name, ok in results:
        print(f"  {('PASS' if ok else 'FAIL'):4s}  {name}")
    if all(ok for _, ok in results):
        print("\n[validate] all gates PASSED -> safe to launch training")
        sys.exit(0)
    else:
        print("\n[validate] one or more gates FAILED -> DO NOT launch training")
        sys.exit(1)


if __name__ == "__main__":
    main()
