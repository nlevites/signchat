"""Training entrypoint for the hoyso48 1st-place asl-signs port.

Usage:
    python -m src.train --config configs/pretrain_phase1_kaggle.yaml
    python -m src.train --config configs/pretrain_phase1_kaggle.yaml --epochs 5
    python -m src.train --config configs/pretrain_phase1_kaggle.yaml --batch-size 256

What it does (faithful port of cell 18 of the reference notebook):

  1. Sets bf16 mixed precision + XLA JIT (Hopper-class GPUs only).
  2. Loads the .npy cache via ``src.data.tfrecords.build_datasets`` -> raw
     (T, 543, 3) -> filter NaNs -> augment_fn -> Preprocess -> padded_batch.
  3. Builds the AWP-wrapped Conv1D-Transformer, ``dim=192`` by default.
  4. Schedule: OneCycleLR (warmup_type=linear, decay_type=cosine), peak lr
     applied to BOTH the LR and the weight_decay so wd follows the same shape.
  5. Optimizer: tf.keras.optimizers.AdamW (native, XLA-clean). The original
     hoyso48 recipe uses Lookahead(RectifiedAdam); we substituted AdamW so
     XLA jit_compile=True works, since the tfa Lookahead wrapper creates a
     `sma_threshold` resource lazily inside a tf.cond on the CPU during the
     first apply_gradients and XLA's strict device placement then fails
     when the GPU train step tries to read it.
  6. Loss: CategoricalCrossentropy(from_logits=True, label_smoothing=0.1).
  7. Train + val per epoch, best-on-val_acc checkpoint, optional Snapshot
     callback every snapshot_epoch.

Outputs land in:
    pretrained/<experiment.name>/best.weights.h5      # best val_acc snapshot
    pretrained/<experiment.name>/last.weights.h5      # last epoch
    pretrained/<experiment.name>/saved_model/         # full TF SavedModel
    pretrained/<experiment.name>/vocab.json           # I/O sidecar
    pretrained/<experiment.name>/temperature.json     # placeholder T=1.0
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

# Cap TF / OpenMP / BLAS thread pools BEFORE importing TF. RunPod H200 hosts
# expose 100+ vCPUs to the container; TF defaults to one thread per core for
# both intra- and inter-op pools, then CUDA PTX JIT and tf.data prefetchers
# layer their own threads on top. The combined fan-out exceeds the
# container's RLIMIT_NPROC and crashes with
# "Thread tf_ creation via pthread_create() failed (errno 11)" partway into
# the first XLA-compiled train step. These caps are conservative; the model
# is GPU-bound (~1.7 M params, batch=512 on H200) so the host CPU thread
# pool is not on the perf-critical path.
os.environ.setdefault("TF_NUM_INTRAOP_THREADS", "8")
os.environ.setdefault("TF_NUM_INTEROP_THREADS", "2")
os.environ.setdefault("OMP_NUM_THREADS", "8")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "8")
os.environ.setdefault("MKL_NUM_THREADS", "8")

import tensorflow as tf

tf.config.threading.set_intra_op_parallelism_threads(
    int(os.environ["TF_NUM_INTRAOP_THREADS"]))
tf.config.threading.set_inter_op_parallelism_threads(
    int(os.environ["TF_NUM_INTEROP_THREADS"]))

# Speedup stack (Hopper-class GPUs only; safe no-op on M4 metal / CPU smoke).
_gpus = tf.config.list_physical_devices("GPU")
if _gpus:
    tf.keras.mixed_precision.set_global_policy("mixed_bfloat16")
    # Auto-clustering JIT: opportunistically fuses ops in the train step
    # graph. Combined with model.compile(jit_compile=True) below, the whole
    # train_function compiles into a single XLA cluster on H200, which
    # roughly halves per-epoch wall vs eager TF on this Conv1D-Transformer.
    tf.config.optimizer.set_jit(True)
    print(f"[train] enabled bf16 mixed precision + XLA JIT "
          f"({len(_gpus)} GPU(s) detected)")

from .awp import AWP
from .config import load_config
from .data.tfrecords import build_datasets
from .landmarks import CHANNELS
from .model import get_model
from .onecycle import OneCycleLR


def _make_run_id(cfg: dict) -> str:
    return f"{cfg['experiment']['name']}_{int(time.time())}"


def _resolve_out_dir(cfg: dict) -> Path:
    name = cfg["experiment"]["name"]
    kind = cfg["experiment"].get("kind", "experiment")
    root = Path("pretrained") if kind == "pretrain" else Path("checkpoints")
    return root / name


def _benchmark_latency(model: tf.keras.Model, max_len: int, n: int = 50) -> float:
    feats = tf.fill((1, max_len, CHANNELS), 0.0)
    for _ in range(5):
        model(feats, training=False)
    t0 = time.time()
    for _ in range(n):
        model(feats, training=False)
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
                        help="override cfg.train.batch_size")
    parser.add_argument("--epochs", type=int, default=None,
                        help="override cfg.train.epochs (use --epochs 5 for a smoke)")
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

    # Build datasets + meta.
    datasets = build_datasets(cfg)
    meta = datasets["meta"]
    num_classes = meta["num_classes"]
    max_len = meta["max_len"]
    print(f"[train] data: train={meta['n_train']} val={meta['n_val']} "
          f"val_signer={meta['n_val_signer']} | classes={num_classes} max_len={max_len}")

    # Schedule + optimizer.
    train_cfg = cfg["train"]
    batch_size = int(train_cfg["batch_size"])
    epochs = int(train_cfg["epochs"])
    base_lr = float(train_cfg["lr"])
    weight_decay = float(train_cfg.get("weight_decay", 0.0))
    warmup_epochs = float(train_cfg.get("warmup_epochs", 0))
    decay_type = train_cfg.get("decay_type", "cosine")
    lr_min = float(train_cfg.get("lr_min", 1e-6))

    steps_per_epoch = max(1, meta["n_train"] // batch_size)
    print(f"[train] schedule: OneCycleLR lr={base_lr:.2e}->{lr_min:.2e} "
          f"warmup={warmup_epochs}ep decay={decay_type} steps/epoch={steps_per_epoch}")

    lr_schedule = OneCycleLR(
        lr=base_lr, epochs=epochs, steps_per_epoch=steps_per_epoch,
        decay_epochs=epochs, warmup_epochs=warmup_epochs,
        lr_start=0.0, lr_min=lr_min,
        warmup_type=train_cfg.get("warmup_type", "linear"),
        decay_type=decay_type,
    )
    wd_schedule = OneCycleLR(
        lr=base_lr * weight_decay, epochs=epochs, steps_per_epoch=steps_per_epoch,
        decay_epochs=epochs, warmup_epochs=warmup_epochs,
        lr_start=0.0, lr_min=lr_min * weight_decay,
        warmup_type=train_cfg.get("warmup_type", "linear"),
        decay_type=decay_type,
    )

    # Native Keras AdamW. The published hoyso48 recipe uses
    # Lookahead(RectifiedAdam); we substitute AdamW because:
    #   - tfa.optimizers.RectifiedAdam creates a `sma_threshold` resource
    #     lazily inside a tf.cond on the CPU during the first
    #     apply_gradients, which XLA's strict device placement then
    #     refuses to read from a GPU-compiled train step.
    #   - tfa is in maintenance and pinned to TF 2.11/2.12 for new releases.
    # AdamW is a small recipe delta (~0.5 pp expected vs Lookahead-RAdam)
    # but it preserves XLA, which doubles training throughput on H200.
    optimizer = tf.keras.optimizers.AdamW(
        learning_rate=lr_schedule,
        weight_decay=wd_schedule,
        beta_1=0.9, beta_2=0.999, epsilon=1e-7,
    )

    # Build model + AWP wrap.
    awp_enabled = bool(train_cfg.get("awp", False))
    awp_lambda = float(train_cfg.get("awp_lambda", 0.2))
    awp_start_epoch = int(train_cfg.get("awp_start_epoch", 15))
    dropout_start_epoch = int(train_cfg.get("dropout_start_epoch", 15))
    dropout_step = dropout_start_epoch * steps_per_epoch
    awp_step = awp_start_epoch * steps_per_epoch

    model_cfg = cfg["model"]
    base_model = get_model(
        num_classes=num_classes, max_len=max_len, channels=CHANNELS,
        dim=int(model_cfg["dim"]), dropout_step=dropout_step,
        kernel_size=int(model_cfg.get("kernel_size", 17)),
        conv_drop=float(model_cfg.get("conv_drop", 0.2)),
        transformer_expand=int(model_cfg.get("transformer_expand", 2)),
        late_drop=float(model_cfg.get("late_drop", 0.8)),
    )
    print(f"[train] model: dim={model_cfg['dim']} params={base_model.count_params():,}")

    if awp_enabled:
        model = AWP(base_model.input, base_model.output,
                    delta=awp_lambda, eps=0.0, start_step=awp_step)
        print(f"[train] AWP enabled: delta={awp_lambda} start_step={awp_step} "
              f"(epoch {awp_start_epoch})")
    else:
        model = base_model

    resume = train_cfg.get("resume_from")
    if resume:
        rp = Path(resume)
        if rp.exists():
            try:
                model.load_weights(str(rp), skip_mismatch=True, by_name=True)
                print(f"[train] resumed weights from {rp}")
            except Exception as e:
                print(f"[train] WARN resume failed ({e}); training from scratch")

    label_smoothing = float(train_cfg.get("label_smoothing", 0.1))
    # XLA on: native Keras AdamW (above) keeps all optimizer state on the
    # GPU device, so jit_compile=True can fuse the entire train step into
    # a single XLA cluster. ~2x epoch wall-clock speedup vs eager TF on
    # H200 for this Conv1D-Transformer. The tfa Lookahead+RAdam pair
    # blocked this in earlier revisions; see optimizer comment above.
    model.compile(
        optimizer=optimizer,
        loss=tf.keras.losses.CategoricalCrossentropy(
            from_logits=True, label_smoothing=label_smoothing,
        ),
        metrics=[tf.keras.metrics.CategoricalAccuracy(name="acc")],
        # steps_per_execution > 1 fuses N steps into a single tf.function
        # call (~5-10% extra on H200) but suppresses per-step metric
        # writes, which makes the epoch-end log show loss=0 / acc=0 in
        # some TF 2.15 + AWP combinations. 16 is a safe middle ground.
        steps_per_execution=16,
        jit_compile=bool(_gpus),
    )

    # Callbacks.
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
        patience = int(train_cfg.get("early_stop_patience", 0) or 0)
        if patience > 0:
            callbacks.append(tf.keras.callbacks.EarlyStopping(
                monitor="val_acc",
                mode="max",
                patience=patience,
                restore_best_weights=True,
            ))
    callbacks.append(tf.keras.callbacks.CSVLogger(
        str(out_dir / "logs.csv"), append=False,
    ))

    val_n = meta.get("n_val_signer") or meta.get("n_val") or 0
    val_steps = max(1, val_n // batch_size) if val_n else None
    history = model.fit(
        datasets["train"],
        validation_data=monitor_ds,
        epochs=epochs,
        steps_per_epoch=steps_per_epoch,
        validation_steps=val_steps,
        callbacks=callbacks,
        verbose=2,
    )

    # Save artifacts. Use the underlying base_model for save_weights so we
    # don't pickle the AWP wrapper class (which depends on this repo).
    base_model.save_weights(str(out_dir / "last.weights.h5"))
    base_model.save(out_dir / "saved_model", save_format="tf")
    print(f"[train] saved -> {out_dir}")

    sidecar = out_dir / "vocab.json"
    sidecar.write_text(json.dumps({
        "vocab": list(meta["vocab"]),
        "n_classes": num_classes,
        "source_config": args.config,
        "experiment_name": cfg["experiment"]["name"],
        "run_id": run_id,
        "model": {
            "name": "islr_hoyso48",
            "dim": int(model_cfg["dim"]),
            "kernel_size": int(model_cfg.get("kernel_size", 17)),
            "transformer_expand": int(model_cfg.get("transformer_expand", 2)),
            "conv_drop": float(model_cfg.get("conv_drop", 0.2)),
            "late_drop": float(model_cfg.get("late_drop", 0.8)),
        },
        "data": {
            "max_len": max_len,
            "channels": CHANNELS,
        },
    }, indent=2))
    print(f"[train] wrote vocab sidecar -> {sidecar} ({num_classes} classes)")

    # Placeholder temperature.json (T=1.0 identity; calibrate fits real T post-hoc).
    temp_sidecar = out_dir / "temperature.json"
    if not temp_sidecar.exists():
        temp_sidecar.write_text(json.dumps({
            "T": 1.0,
            "_note": "Placeholder. Fit real T with `python -m src.calibrate --checkpoint <dir>`.",
            "_run_id": run_id,
        }, indent=2) + "\n")

    train_acc = float(history.history.get("acc", [0.0])[-1])
    val_acc = ""
    val_signer_acc = ""
    if datasets.get("val") is not None and "val_acc" in history.history:
        # If the val/val_signer monitor was val_signer, the per-epoch val_acc is
        # for val_signer; we additionally evaluate val explicitly if both exist.
        if datasets.get("val_signer") is not None and monitor_ds is datasets.get("val_signer"):
            val_signer_acc = float(history.history.get("val_acc", [0.0])[-1])
            # base_model is the inner Keras Model whose AWP wrapper handled
            # compilation; explicit evaluate(base_model) hits "model not
            # compiled". Recompile with the same loss/metrics for the eval
            # pass; weights are already trained.
            try:
                base_model.compile(
                    loss=tf.keras.losses.CategoricalCrossentropy(
                        from_logits=True, label_smoothing=label_smoothing,
                    ),
                    metrics=[tf.keras.metrics.CategoricalAccuracy(name="acc")],
                )
                results = base_model.evaluate(
                    datasets["val"], verbose=0, return_dict=True,
                    steps=max(1, meta.get("n_val", 0) // batch_size) or None,
                )
                val_acc = float(results.get("acc", 0.0))
            except Exception as e:
                print(f"[train] WARN explicit val eval failed: {e}")
        else:
            val_acc = float(history.history.get("val_acc", [0.0])[-1])
    elif datasets.get("val_signer") is not None and "val_acc" in history.history:
        val_signer_acc = float(history.history.get("val_acc", [0.0])[-1])

    latency_ms = ""
    if cfg.get("eval", {}).get("benchmark_latency", True):
        try:
            latency_ms = round(_benchmark_latency(base_model, max_len), 2)
        except Exception as e:
            print(f"[train] WARN latency benchmark failed: {e}")

    _append_experiment_row({
        "run_id": run_id,
        "timestamp": int(time.time()),
        "config": args.config,
        "model": "islr_hoyso48",
        "vocab_size": num_classes,
        "train_acc": round(train_acc, 4),
        "val_acc": round(val_acc, 4) if isinstance(val_acc, float) else val_acc,
        "val_signer_acc": round(val_signer_acc, 4) if isinstance(val_signer_acc, float) else val_signer_acc,
        "latency_ms": latency_ms,
        "n_params": base_model.count_params(),
        "notes": cfg["experiment"].get("notes", ""),
    })
    print("[train] appended row to experiments.csv")


if __name__ == "__main__":
    main()
