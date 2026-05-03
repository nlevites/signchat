# SignChatModel

Real-time American Sign Language → text MVP. MediaPipe Holistic landmarks → small Conformer classifier → live webcam demo on M-series Mac (or any Linux GPU).

The primary training target is the **PopSign 250-sign vocabulary** (the Google Kaggle ISLR / `asl-signs` competition dataset). Architecture and recipe follow the Kaggle ASL ISLR 1st/2nd-place winners:

1. small Conformer (~5–8 M params; `dim=192`, 6 blocks)
2. short sequences (`max_len=160`)
3. position + velocity + acceleration channels (`n_channels=9`)
4. CutMix at the batch level

A cross-dataset broad/tight head-swap recipe is preserved as a secondary path for cases where PopSign 250 doesn't cover the target lexicon.

---

## Quick start

```bash
# 1. Setup (Python 3.10 or 3.11 only — TF + MediaPipe constraint)
python -m venv .venv && source .venv/bin/activate
make install
cp .env.example .env
# Edit .env: RUNPOD_API_KEY, KAGGLE_USERNAME, KAGGLE_KEY.

# 2. Train PopSign 250 on a RunPod H200 (~$8, ~2 hr)
caffeinate -dimsuw $$ \
    make pod-train-phase1-kaggle VOLUME_ID=412s5n8qkh

# 3. Calibrate + demo (local, no GPU)
make calibrate CKPT=pretrained/phase1_kaggle/
make demo      CKPT=pretrained/phase1_kaggle/
```

`make help` lists every target with one-line descriptions.

---

## What's in the repo

```
configs/                YAML recipes (extend base.yaml via `extends:`)
data/splits/            signer-disjoint train/val/held JSON
data/vocab/             locked vocabularies (PopSign 250, Coffee Chat 25, etc.)
src/                    model + preprocessing + training + demo
src/data/               dataset loaders + tf.data pipeline (.npy backed)
scripts/                RunPod orchestration + tooling
tests/                  CPU-only unit tests (`make test`)
```

Gitignored runtime artifacts:

```
data/cache/             MediaPipe landmark caches (live on the RunPod volume)
pretrained/             trained checkpoints (populated by pod-train targets)
.env, kaggle.json       credentials (BYO)
*.log, _logs/           pod orchestration logs
```

---

## Architecture

A small Conformer encoder over 130 MediaPipe Holistic landmarks per frame, 160 frames per clip, with 9 input channels (xyz + first-difference + second-difference). Trained as either a 250-class PopSign softmax (primary) or as a transfer-base broad model that head-swaps to a tight demo lexicon (secondary).

```
landmarks (T, 543, 3)
    ↓ src/landmarks.py:  pick 76 face + 12 pose + 42 hands → (T, 130, 3)
    ↓ src/preprocessing.py:
        per-clip mean/std normalization, NaN→0
        handedness flip → canonical right-handed
        time resample to max_len=160
        concat first-diff (vel) + second-diff (accel) → (T, 130, 9)
    ↓ src/model.py: Conformer encoder
        dim=192, 6 blocks, 6 heads, conv_kernel=31, ffn_expansion=4
        ~5–8 M params
    ↓ MaskedGlobalAveragePool1D
    ↓ Dense(N_classes) → softmax
```

Why these sizes: the asl-signs Kaggle 1st/2nd-place winners had a 40 MB TFLite cap that forced ~5–10 M params; that turned out to be the right capacity for landmark-only ISLR — scaling beyond it on this data hurts rather than helps.

Inference path: tensorflow-metal on M-series Mac, ~5–10 ms per window (160 frames). MediaPipe Holistic dominates wall time at ~25–35 ms/frame; the demo runs the model every 8 frames to stay realtime.

---

## Training recipes

All configs inherit from `[configs/base.yaml](configs/base.yaml)`.

### Primary: PopSign 250 single-source — `[configs/pretrain_phase1_kaggle.yaml](configs/pretrain_phase1_kaggle.yaml)`

```
data:
  cache_dir:    [data/cache/kaggle_islr]   # 94k npy, 250 PopSign signs
  vocab:        auto                        # resolves to 250-class softmax
  splits_path:  data/splits/kaggle_islr.json   # 13/4/4 signer split
train:
  batch_size: 256, epochs: 30, lr: 5e-4, warmup_epochs: 2,
  schedule: cosine, early_stop_patience: 8
```

Output: `pretrained/phase1_kaggle/{best.weights.h5, vocab.json, temperature.json, saved_model/}`.

### Smoke gate — `[configs/pretrain_phase1_kaggle_smoke.yaml](configs/pretrain_phase1_kaggle_smoke.yaml)`

Same data + same architecture, only 2 epochs. Cheap drift gate (~$3 H200, ~45 min) before committing to the full run. Gate threshold: `**val_acc ≥ 0.10**` at epoch 2 to proceed.

### Secondary: cross-dataset broad + tight head-swap

Use when the PopSign 250 vocabulary doesn't cover the target demo lexicon (e.g. the 25-sign Coffee Chat script).

- `[pretrain_phase1_broad.yaml](configs/pretrain_phase1_broad.yaml)`: 4-cache union (`asl_citizen` + `wlasl` + `wlasl_full` + `kaggle_islr`), `vocab: auto` resolves to ~1100+ classes, 60 epochs, ~$16, ~4 hr.
- `[pretrain_phase1_tight.yaml](configs/pretrain_phase1_tight.yaml)`: 25-class tight softmax, `resume_from: pretrained/phase1_broad/best.weights.h5`, head-swap via `load_weights(by_name=True, skip_mismatch=True)`. ~$6, ~1.5 hr.

Cross-dataset loaders (`[src/data/asl_citizen_loader.py](src/data/asl_citizen_loader.py)`, `[src/data/wlasl_kaggle_loader.py](src/data/wlasl_kaggle_loader.py)`, `[src/data/wlasl_raw_loader.py](src/data/wlasl_raw_loader.py)`) and the gloss alias resolver (`[src/data/gloss_aliases.py](src/data/gloss_aliases.py)`) stay in the repo as the secondary path.

---

## Inference contract layer

The realtime demo doesn't just argmax the softmax — it goes through a state machine (`[src/contract.py](src/contract.py)`) that:

- emits a `TickEvent` per inference window (top-K + max prob + entropy + motion energy)
- gates low-confidence ticks (`max_prob < oov_gate`) so a fluent off-script sign reads as `?` instead of a confident wrong guess
- requires `stability_k` consecutive agreeing windows before committing
- short-circuits to "idle" when hand motion energy is below threshold
- streams every tick as JSONL via `[src/llm_bridge.py](src/llm_bridge.py)` for a downstream LLM consumer (see `[scripts/llm_consumer.py](scripts/llm_consumer.py)`)

Knobs live in `[configs/contract.yaml](configs/contract.yaml)` — tune per camera/signer/venue without retraining.

`[src/calibrate.py](src/calibrate.py)` fits a scalar temperature `T` on `val_signer` and writes `temperature.json` next to the checkpoint. The demo divides logits by `T` before softmax, so `prob=0.7` actually means the model is right ~70% of the time. Argmax is preserved (top-1 acc unchanged); only confidence is honest-up'd for the LLM consumer.

End-to-end:

```bash
python -m src.realtime_demo --checkpoint pretrained/phase1_kaggle/ \
    --llm-bridge stdout | \
    python scripts/llm_consumer.py --provider claude
```

---

## RunPod tips

### Wrap long pod-launch commands in `caffeinate -dimsuw $$`

A sleeping Mac silently strands SSH/rsync while the GPU pod keeps billing. Prepend `caffeinate -dimsuw $$` to any long-running pod target.

### Pass `VOLUME_ID=<id>` to every phase1 pod-train target

When set, the H200 train pod mounts the network volume at `/workspace` and the per-dataset caches (`asl_citizen`, `wlasl`, `wlasl_full`, `kaggle_islr`) are **symlinked** from `/workspace/cache/<dataset>/` into the repo's `data/cache/` instead of rsync'd from local. Without it the orchestrator falls back to rsyncing 95k+ small npy files over inter-DC SSH, which is much slower and more fragile.

The active EU-RO-1 volume is `**412s5n8qkh`** (300 GB). It holds the full `asl_citizen`, `wlasl`, `wlasl_full`, and `kaggle_islr` (PopSign) `.npy` caches plus their raw inputs.

### RunPod S3 env-var names are intentionally swapped

`.env` ships:

```
RUNPOD_S3_KEY          = <access key>   (looks like user_3CZ...)
RUNPOD_S3_ACCESS_KEY   = <secret>       (looks like rps_4FY...)
```

The names are swapped relative to what they mean — the runtime reads them this way. Endpoint: `https://s3api-eu-ro-1.runpod.io`, region `eu-ro-1`, bucket = volume id. Use `signature_version='s3v4'` and `addressing_style='path'`. Lets you read/inspect the volume from boto3 without spinning up a diagnostic pod.

---

## End-to-end commands


| Step                                       | Command                                                                         | Cost / time         |
| ------------------------------------------ | ------------------------------------------------------------------------------- | ------------------- |
| Extract PopSign onto the volume (one-time) | `make pod-kaggle-islr VOLUME_ID=412s5n8qkh`                                     | ~$0.30 / ~30–60 min |
| Schema sanity check (no spend)             | `make kaggle-islr-validate`                                                     | <30 sec local       |
| Smoke gate (drift check)                   | `caffeinate -dimsuw $$ make pod-train-phase1-kaggle-smoke VOLUME_ID=412s5n8qkh` | ~$3 / ~45 min       |
| Full PopSign train                         | `caffeinate -dimsuw $$ make pod-train-phase1-kaggle VOLUME_ID=412s5n8qkh`       | ~$8 / ~2 hr         |
| Calibrate temperature                      | `make calibrate CKPT=pretrained/phase1_kaggle/`                                 | ~30 sec local       |
| Eval on held-out signers                   | `make eval CKPT=pretrained/phase1_kaggle/`                                      | ~1 min local        |
| Live demo                                  | `make demo CKPT=pretrained/phase1_kaggle/`                                      | webcam, no pod      |
| Unit tests                                 | `make test`                                                                     | ~1 sec              |


Cross-dataset secondary path (only if PopSign 250 misses your demo lexicon):


| Step            | Command                                                                  | Cost / time       |
| --------------- | ------------------------------------------------------------------------ | ----------------- |
| Broad pretrain  | `caffeinate -dimsuw $$ make pod-train-phase1-broad VOLUME_ID=412s5n8qkh` | ~$16–23 / ~4–6 hr |
| Tight head-swap | `caffeinate -dimsuw $$ make pod-train-phase1-tight VOLUME_ID=412s5n8qkh` | ~$6 / ~1.5 hr     |


---

## Apple Silicon notes

`requirements.txt` ships `tensorflow==2.15.1` for non-Linux. That works on M-series CPU and is fine for the demo (~15 ms inference per window). For Metal GPU acceleration, swap the non-Linux line to:

```
tensorflow-macos==2.15.0
tensorflow-metal==1.1.0
```

The pod-side install always uses `tensorflow[and-cuda]==2.15.1` per the `sys_platform == "linux"` marker.

---

## Validation

```bash
make test                              # 19 unit tests, ~1 sec, CPU only
make kaggle-islr-validate              # 5-clip parquet schema check, <30 sec
make pretrain-phase1-kaggle-smoke      # 2-epoch local smoke (needs cache)
```

`tests/` contains:

- `[test_contract.py](tests/test_contract.py)` — 15 unit tests for the inference state machine (no TF dependency).
- `[test_kaggle_islr_loader.py](tests/test_kaggle_islr_loader.py)` — 4 regression tests guarding (a) `parquet_to_tensor` produces the canonical (T, 543, 3) layout in [Pose, Face, LHand, RHand] order with NaNs preserved, and (b) the Kaggle-sign → disk-gloss map pairs by prediction index, not by JSON insertion order.

---

## Migration notes (when moving into a new sub-repo)

This repo is intentionally lean for the migration:

- **Single-source-of-truth README** (this file). No `docs/` packet — everything operationally important is here.
- **All credentials via `.env`** (gitignored). Copy `.env.example` and fill.
- **Heavy artifacts live on RunPod volume `412s5n8qkh`**, not in the repo. The only PopSign artifact tracked locally is `data/vocab/kaggle_islr.json` plus the auto-written `data/splits/kaggle_islr.json` (~1 KB).
- **No installable package**: the repo is run as `python -m src.<module>` from the repo root, driven by the [Makefile](Makefile). If you want a `pyproject.toml` install in the new repo, the `src/` layout is already set up for it.
- **Python 3.10 / 3.11 only** (pinned in `[.python-version](.python-version)`) — TF 2.15 + MediaPipe 0.10.9 constraint.

