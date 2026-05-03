"""Training entrypoint.

Usage:
    python -m src.train --config configs/pretrain_phase1_kaggle.yaml
    python -m src.train --config configs/pretrain_phase1_broad.yaml

Each run:
  - Loads cached landmark .npy files via src.data.tfrecords.build_datasets
  - Builds the model named in cfg.model.name
  - Optionally resumes weights from cfg.train.resume_from
  - Trains, evaluates on val + held-out signer
  - Saves to a stable directory:
        pretrained/<experiment.name>/   if cfg.experiment.kind == "pretrain"
        checkpoints/<experiment.name>/  otherwise
    Re-running the same experiment.name overwrites the previous artifacts on
    disk; full run history with metrics lives in experiments.csv (one row per
    run, keyed by timestamped run_id).
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import time
from pathlib import Path

# Disable oneDNN custom ops BEFORE importing TF. TF 2.15 with oneDNN on (the
# default) fuses LayerNormalization into _MklLayerNorm which only has CPU
# OpKernels registered, so validation crashes with "No registered
# '_MklLayerNorm' OpKernel for 'GPU' devices". Setting this to "0" makes TF
# fall back to the standard layer_norm kernels which work on GPU.
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import tensorflow as tf

# Speedup stack (Hopper-class GPUs only; safe no-op on M4 metal / CPU smoke).
# - bf16 mixed precision: ~2x throughput on H100/H200 tensor cores. Same
#   exponent range as fp32 so no loss-scaling needed (unlike fp16). Final
#   softmax stays fp32 via dtype="float32" on the last Dense (see model.py).
# - XLA JIT: op fusion + graph compile. Set globally here AND redundantly
#   enabled per-model via jit_compile=True in compile() so SavedModel export
#   bakes the same compilation in.
_gpus = tf.config.list_physical_devices("GPU")
if _gpus:
    tf.keras.mixed_precision.set_global_policy("mixed_bfloat16")
    tf.config.optimizer.set_jit(True)
    print(f"[train] enabled bf16 mixed precision + XLA JIT "
          f"({len(_gpus)} GPU(s) detected)")

from .config import load_config
from .data.tfrecords import build_datasets
from .model import build_classifier


def _make_run_id(cfg: dict) -> str:
    """Unique identifier for the experiments.csv log row (NOT the disk dir)."""
    return f"{cfg['experiment']['name']}_{int(time.time())}"


def _resolve_out_dir(cfg: dict) -> Path:
    """Stable on-disk directory for the run's checkpoints + saved_model.

    Routing:
      - cfg.experiment.kind == "pretrain"  ->  pretrained/<experiment.name>/
      - anything else                       ->  checkpoints/<experiment.name>/

    No timestamp in the path: re-running with the same `experiment.name`
    overwrites the previous artifacts. This makes downstream `resume_from`
    references stable strings rather than guessable timestamps.
    """
    name = cfg["experiment"]["name"]
    kind = cfg["experiment"].get("kind", "experiment")
    root = Path("pretrained") if kind == "pretrain" else Path("checkpoints")
    return root / name


def _build_optimizer(cfg: dict, steps_per_epoch: int) -> tf.keras.optimizers.Optimizer:
    train_cfg = cfg["train"]
    base_lr = float(train_cfg["lr"])
    epochs = int(train_cfg["epochs"])
    warmup_epochs = int(train_cfg.get("warmup_epochs", 0))
    schedule_name = train_cfg.get("schedule", "constant")

    total_steps = max(1, epochs * max(1, steps_per_epoch))
    warmup_steps = max(1, warmup_epochs * max(1, steps_per_epoch))

    if schedule_name == "cosine":
        decay = tf.keras.optimizers.schedules.CosineDecay(
            initial_learning_rate=base_lr,
            decay_steps=total_steps - warmup_steps,
            alpha=0.01,
            warmup_target=base_lr,
            warmup_steps=warmup_steps,
        )
        lr = decay
    else:
        lr = base_lr

    return tf.keras.optimizers.AdamW(
        learning_rate=lr,
        weight_decay=float(train_cfg.get("weight_decay", 0.0)),
    )


def _benchmark_latency(model: tf.keras.Model, cfg: dict, n: int = 50) -> float:
    feats = tf.zeros((1, cfg["data"]["max_len"], cfg["data"]["n_landmarks"], cfg["data"]["n_channels"]))
    mask = tf.ones((1, cfg["data"]["max_len"]), dtype=tf.bool)
    for _ in range(5):
        model([feats, mask], training=False)
    t0 = time.time()
    for _ in range(n):
        model([feats, mask], training=False)
    return (time.time() - t0) / n * 1000.0


def _append_experiment_row(row: dict, path: Path = Path("experiments.csv")):
    cols = ["run_id", "timestamp", "config", "model", "vocab_size",
            "train_acc", "val_acc", "val_signer_acc", "latency_ms", "n_params", "notes"]
    write_header = not path.exists() or path.stat().st_size == 0
    with path.open("a", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        if write_header:
            w.writeheader()
        w.writerow({k: row.get(k, "") for k in cols})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--batch-size", type=int, default=None,
                        help="override cfg.train.batch_size (used by runpod_train.py "
                             "to pick a per-GPU batch via BATCH_BY_GPU)")
    parser.add_argument("--epochs", type=int, default=None,
                        help="override cfg.train.epochs. Used for short smoke "
                             "runs (e.g. --epochs 3 on the broad config to validate "
                             "a recipe change for ~$3 instead of paying for a full "
                             "60-epoch ~$25 broad run).")
    args = parser.parse_args()

    cfg = load_config(args.config)
    if args.batch_size is not None:
        prev = cfg["train"].get("batch_size")
        cfg["train"]["batch_size"] = args.batch_size
        print(f"[train] batch_size override: {prev} -> {args.batch_size}")
    if args.epochs is not None:
        prev = cfg["train"].get("epochs")
        cfg["train"]["epochs"] = args.epochs
        print(f"[train] epochs override: {prev} -> {args.epochs}")

    run_id = _make_run_id(cfg)
    out_dir = _resolve_out_dir(cfg)
    out_dir.mkdir(parents=True, exist_ok=True)

    print(f"[train] run_id={run_id}")
    print(f"[train] config={args.config}")
    print(f"[train] out_dir={out_dir}")

    datasets = build_datasets(cfg)
    meta = datasets["meta"]
    print(f"[train] data: train={meta['n_train']} "
          f"val={meta['n_val']} val_signer={meta['n_val_signer']}")
    if meta.get("train_balanced"):
        breakdown = ", ".join(
            f"{s['source']}={s['n_train']}" for s in meta.get("train_sources", [])
        )
        print(f"[train] train pipeline: per-source balanced sampling "
              f"(equal weights) -> {breakdown}")
    elif meta.get("train_sources"):
        breakdown = ", ".join(
            f"{s['source']}={s['n_train']}" for s in meta["train_sources"]
        )
        print(f"[train] train pipeline: single-source -> {breakdown}")

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
        dropout=cfg["model"].get("dropout", 0.2),
    )
    print(f"[train] model={cfg['model']['name']} params={model.count_params():,}")

    resume = cfg["train"].get("resume_from")
    if resume:
        resume_path = Path(resume)
        if resume_path.exists():
            try:
                model.load_weights(str(resume_path), skip_mismatch=True, by_name=True)
                print(f"[train] resumed weights from {resume_path}")
            except Exception as e:
                print(f"[train] WARN resume failed ({e}); training from scratch")

    n_train = datasets["meta"]["n_train"]
    steps_per_epoch = max(1, (n_train + cfg["train"]["batch_size"] - 1) // cfg["train"]["batch_size"])
    optimizer = _build_optimizer(cfg, steps_per_epoch)

    # CutMix yields soft (one-hot blended) labels via build_batch_cutmix.
    # When CutMix is on, both train and val pipelines emit one-hot labels so
    # the same compiled loss + metric work for both. When off, keep the
    # cheaper sparse path.
    cutmix_enabled = bool(datasets["meta"].get("cutmix_enabled"))
    if cutmix_enabled:
        loss_fn = tf.keras.losses.CategoricalCrossentropy(from_logits=True)
        acc_metric = tf.keras.metrics.CategoricalAccuracy(name="acc")
        print(f"[train] CutMix enabled: using CategoricalCrossentropy + "
              f"CategoricalAccuracy (one-hot labels)")
    else:
        loss_fn = tf.keras.losses.SparseCategoricalCrossentropy(from_logits=True)
        acc_metric = tf.keras.metrics.SparseCategoricalAccuracy(name="acc")

    model.compile(
        optimizer=optimizer,
        loss=loss_fn,
        metrics=[acc_metric],
        jit_compile=bool(_gpus),
    )

    callbacks = []
    monitor_ds = datasets.get("val_signer") or datasets.get("val")
    if monitor_ds is not None:
        callbacks.append(tf.keras.callbacks.ModelCheckpoint(
            filepath=str(out_dir / "best.weights.h5"),
            save_weights_only=True,
            monitor="val_acc",
            mode="max",
            save_best_only=True,
        ))
        callbacks.append(tf.keras.callbacks.EarlyStopping(
            monitor="val_acc",
            mode="max",
            patience=int(cfg["train"].get("early_stop_patience", 10)),
            restore_best_weights=True,
        ))

    history = model.fit(
        datasets["train"],
        validation_data=monitor_ds,
        epochs=cfg["train"]["epochs"],
        callbacks=callbacks,
        verbose=2,
    )

    model.save(out_dir / "saved_model", save_format="tf")
    print(f"[train] saved -> {out_dir}")

    # Vocab sidecar: pin the EXACT label index <-> gloss mapping the model
    # was trained against. realtime_demo.py refuses to load a checkpoint
    # without this file -- prevents the failure mode where the demo silently
    # picks a vocab that doesn't match the model's softmax dimension.
    sidecar = out_dir / "vocab.json"
    sidecar.write_text(json.dumps({
        "vocab": list(datasets["meta"]["vocab"]),
        "n_classes": num_classes,
        "source_config": args.config,
        "experiment_name": cfg["experiment"]["name"],
        "run_id": run_id,
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
            "use_motion_deltas": bool(cfg["data"].get("use_motion_deltas",
                                                       cfg["data"].get("n_channels", 6) >= 6)),
            "use_acceleration": bool(cfg["data"].get("use_acceleration",
                                                      cfg["data"].get("n_channels", 6) == 9)),
        },
    }, indent=2))
    print(f"[train] wrote vocab sidecar -> {sidecar} ({num_classes} classes)")

    # Placeholder temperature.json so realtime_demo.py's calibration.apply: true
    # path doesn't have to special-case missing files. T=1.0 is the identity
    # passthrough; src/calibrate.py overwrites this with the fitted T after
    # training. Skipped if a calibrated file already exists from a prior run.
    temp_sidecar = out_dir / "temperature.json"
    if not temp_sidecar.exists():
        temp_sidecar.write_text(json.dumps({
            "T": 1.0,
            "_note": ("Placeholder written by src/train.py at training time. "
                       "Overwrite with `python -m src.calibrate --checkpoint <dir>` "
                       "after training to fit a real temperature on val_signer."),
            "_run_id": run_id,
        }, indent=2) + "\n")
        print(f"[train] wrote placeholder temperature sidecar -> {temp_sidecar}")

    train_acc = float(history.history.get("acc", [0.0])[-1])
    val_acc = float(history.history.get("val_acc", [0.0])[-1]) if monitor_ds is datasets.get("val") else ""
    val_signer_acc = ""
    if datasets.get("val_signer") is not None:
        results = model.evaluate(datasets["val_signer"], verbose=0, return_dict=True)
        val_signer_acc = float(results.get("acc", 0.0))

    latency_ms = _benchmark_latency(model, cfg) if cfg.get("eval", {}).get("benchmark_latency", True) else ""

    _append_experiment_row({
        "run_id": run_id,
        "timestamp": int(time.time()),
        "config": args.config,
        "model": cfg["model"]["name"],
        "vocab_size": num_classes,
        "train_acc": round(train_acc, 4),
        "val_acc": round(val_acc, 4) if isinstance(val_acc, float) else val_acc,
        "val_signer_acc": round(val_signer_acc, 4) if isinstance(val_signer_acc, float) else val_signer_acc,
        "latency_ms": round(latency_ms, 2) if isinstance(latency_ms, float) else latency_ms,
        "n_params": model.count_params(),
        "notes": cfg["experiment"].get("notes", ""),
    })
    print("[train] appended row to experiments.csv")


if __name__ == "__main__":
    main()
