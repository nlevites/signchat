# SignChatModel

Real-time American Sign Language → text MVP. MediaPipe Holistic landmarks → ~1.7M-param Conv1D-Transformer hybrid → live webcam demo on M-series Mac (or any Linux GPU).

The training target is the **PopSign 250-sign vocabulary** (the Google Kaggle ISLR / `asl-signs` competition dataset). Architecture and recipe are a faithful port of [hoyso48's 1st-place solution](https://www.kaggle.com/competitions/asl-signs/discussion/406684) ([reference notebook](https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution/blob/main/ISLR_1st_place_Hoyeol_Sohn.ipynb)) — a Conv1D-Transformer hybrid trained with bf16 + XLA, OneCycleLR cosine, native `tf.keras.optimizers.AdamW`, and AWP regularization. Hardware adaptation: single H200 in place of 8× TPU v3 at the same effective batch size and peak learning rate. Recipe deltas: 200 epochs (vs 300) and AdamW (vs Lookahead-RectifiedAdam) — both for XLA compatibility / wall-clock budget; ~0.5 pp expected accuracy hit.

---

## Quick start

```bash
# 1. Setup (Python 3.10 or 3.11 only — TF + MediaPipe constraint)
python -m venv .venv && source .venv/bin/activate
make install
cp .env.example .env
# Edit .env: RUNPOD_API_KEY, KAGGLE_USERNAME, KAGGLE_KEY.

# 2. Make sure the asl-signs Kaggle competition rules are accepted on your
# Kaggle account at https://www.kaggle.com/competitions/asl-signs/rules
# (the download endpoint silently 403s for unaccepted competitions).

# 3. Extract PopSign onto a RunPod network volume (~$0.30 + ~$3-4 if forced
# onto an H200 due to global CPU pod capacity exhaustion; ~30-60 min). The
# script provisions the pod, downloads + extracts, terminates pod.
caffeinate -dimsuw $$ \
    python -u scripts/runpod_kaggle_islr.py --skip-rsync
# Capture the new volume id printed at the end.

# 4. Train PopSign 250 on a RunPod H200 (~$15, ~3.5 hr; 200 epochs, AdamW + XLA).
caffeinate -dimsuw $$ \
    make pod-train-phase1-kaggle VOLUME_ID=<volume_id_from_step_3>

# 5. Eval on the held-out signers (local, no GPU).
make eval CKPT=pretrained/phase1_kaggle/
```

`make help` lists every target with one-line descriptions.

---

## What's in the repo

```
configs/                YAML recipes (extend base.yaml via `extends:`)
data/splits/            signer-disjoint train/val/held JSON
data/vocab/             locked vocabularies (PopSign 250)
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
.venv/                  local Python venv
```

---

## Architecture

A hoyso48-style alternating Conv1D-Transformer over 118 selected MediaPipe Holistic landmarks per frame (40 lip + 21 left hand + 21 right hand + 4 nose + 16 right eye + 16 left eye; pose and most of the face dropped on purpose). 384 frames per clip, 6 channels (only x, y plus 1-step and 2-step temporal differences — z is dropped because hoyso48 found it dilutes the attention signal). Trained as a 250-class PopSign softmax.

```
landmarks (T, 543, 3)                      # raw kaggle parquet
    ↓ src/landmarks.py:  pick the 118 hoyso48 landmarks
    ↓ src/preprocessing.py (Preprocess layer):
        per-clip nose-centered + std normalization
        drop z; keep (x, y) only
        concat [(x, y), 1-step diff, 2-step diff] → (T, 708)
        NaN → 0 after normalization
    ↓ src/augment.py (training only):
        resample(0.5, 1.5) p=0.8                  # time scale
        flip_lr p=0.5                             # mirror x with full L/R block swap
        temporal_crop to max_len=384
        spatial_random_affine p=0.75              # rot ±30°, shear ±0.15, shift ±0.1
        temporal_mask p=0.5                       # 20-40% of frames → NaN
        spatial_mask  p=0.5                       # bbox region → NaN
    ↓ src/model.py: hoyso48 1st-place architecture
        Masking(mask_value=-100) + Dense(192) stem + BN
        Conv1DBlock × 3 (ksize=17, expand=2, ECA, dropout=0.2)
        TransformerBlock × 1 (dim=192, expand=2, attn_dropout=0.2)
        Conv1DBlock × 3
        TransformerBlock × 1
        Dense(384) "top_conv"
        GlobalAveragePooling1D
        LateDropout(0.8, start_step=15ep × steps_per_epoch)
    ↓ Dense(250) → fp32 logits
```

Param count: ~1.7M. Forward pass on H200 is dominated by the optimizer + AWP overhead (the model itself is tiny); on M4 metal it's ~5-10 ms per window.

Why such a small model: the Kaggle ISLR competition had a 40 MB TFLite cap that forced ~1-2M params; that turned out to be the right capacity for landmark-only ISLR — scaling beyond it on this data hurts rather than helps.

Inference path: tensorflow-metal on M-series Mac, ~5-10 ms per window. MediaPipe Holistic dominates wall time at ~25-35 ms/frame; the demo is intended to run the model every 8 frames to stay realtime.

---

## Training recipe

All configs inherit from [`configs/base.yaml`](configs/base.yaml) and the only training entry point is [`configs/pretrain_phase1_kaggle.yaml`](configs/pretrain_phase1_kaggle.yaml).

```yaml
data:
  cache_dir:    [data/cache/kaggle_islr]   # ~94k npy, 250 PopSign signs
  vocab:        auto                       # resolves to 250-class softmax
  splits_path:  data/splits/kaggle_islr.json   # 13/4/4 signer split
  max_len:      384

model:
  dim:                192
  kernel_size:        17
  transformer_expand: 2
  conv_drop:          0.2
  late_drop:          0.8

train:
  batch_size:          512        # = 64 × 8 replicas in the original; H200 fits at b=512
  epochs:              300
  lr:                  4.0e-3     # = 5e-4 × 8 replicas
  lr_min:              1.0e-6
  weight_decay:        0.1        # follows the OneCycle schedule
  warmup_epochs:       0
  decay_type:          cosine
  label_smoothing:     0.1
  awp:                 true
  awp_lambda:          0.2
  awp_start_epoch:     15
  dropout_start_epoch: 15
```

Optimizer: native `tf.keras.optimizers.AdamW(learning_rate=schedule, weight_decay=decay_schedule, beta_1=0.9, beta_2=0.999, epsilon=1e-7)`. Both lr AND weight_decay follow the OneCycleLR shape. With `warmup_epochs=0` this is effectively a pure cosine decay from 4e-3 → 1e-6 across 200 epochs. The published recipe uses `Lookahead(RectifiedAdam)`; we substituted AdamW because the tfa Lookahead wrapper trips XLA's strict device placement on its lazy `sma_threshold` resource — losing XLA roughly doubles wall-clock on H200, so the ~0.5 pp expected accuracy delta is the right trade.

AWP (Adversarial Weight Perturbation, vendored from [hoyso48/tf-utils](https://github.com/hoyso48/tf-utils) at [`src/awp.py`](src/awp.py)): from epoch 15, every train step does (1) forward+backward to get gradients, (2) perturb trainable weights along the L2-normalized gradient with magnitude `delta=0.2`, (3) forward+backward on the perturbed weights, (4) restore weights, (5) apply the adversarial gradient. ~2× per-step cost; materially helps generalization.

LateDropout (vendored): 80% dropout before the classifier, but identity until step `dropout_start_epoch × steps_per_epoch`.

Output: `pretrained/phase1_kaggle/{best.weights.h5, last.weights.h5, vocab.json, temperature.json, saved_model/, logs.csv}`.

### Smoke gate

For a $1 sanity run before committing to the full ~$15 / ~3.5 hr training:

```bash
caffeinate -dimsuw $$ \
    make pod-train-phase1-kaggle VOLUME_ID=<id> EPOCHS=5
```

Gate threshold: `val_acc > 0.04` at epoch 5 (10× random for 250 classes). At b=512, ~94k/512 ≈ 184 steps/epoch × 5 epochs ≈ 920 steps. With label smoothing the random-init loss is ~5.7; we want it dropping clearly below ~5.0 by step ~500.

If smoke fails — first thing to suspect is AWP. Set `awp: false` in `[configs/base.yaml](configs/base.yaml)` and re-smoke to isolate it from the rest of the port.

---

## End-to-end commands

| Step | Command | Cost / time |
|---|---|---|
| Extract PopSign onto a fresh volume (one-time) | `python -u scripts/runpod_kaggle_islr.py --skip-rsync` | ~$0.30-4 / ~30-60 min ([note on capacity](#runpod-tips)) |
| Smoke train (5 epochs) | `caffeinate -dimsuw $$ make pod-train-phase1-kaggle VOLUME_ID=<id> EPOCHS=5` | ~$1 / ~10-15 min |
| Full train (200 epochs) | `caffeinate -dimsuw $$ make pod-train-phase1-kaggle VOLUME_ID=<id>` | ~$15 / ~3.5 hr |
| Eval on held-out signers | `make eval CKPT=pretrained/phase1_kaggle/` | ~1 min local |
| Unit tests | `make test` | ~1 sec |

---

## RunPod tips

### Wrap long pod-launch commands in `caffeinate -dimsuw $$`

A sleeping Mac silently strands SSH/rsync while the GPU pod keeps billing. Prepend `caffeinate -dimsuw $$` to any long-running pod target.

### Pass `VOLUME_ID=<id>` to every pod-train invocation

When set, the H200 train pod mounts the network volume at `/workspace`, and `data/cache/kaggle_islr/` is **symlinked** from `/workspace/cache/kaggle_islr/` into the repo's `data/cache/` instead of rsync'd from local. Without it the orchestrator falls back to rsyncing 92k+ small npy files over inter-DC SSH, which is much slower and more fragile.

### Capacity falls back gracefully

[`scripts/runpod_kaggle_islr.py`](scripts/runpod_kaggle_islr.py) now iterates through CPU flavors (`cpu5c` → `cpu3c` → `cpu5g`) × cloud tiers (`SECURE` → `COMMUNITY`) before failing. If global CPU pod capacity is exhausted (this happens), pass `--gpu "NVIDIA H200"` to fall back to a GPU pod for the extract — wasteful at ~$4/hr but unblocks the pipeline. Add `--cpu-flavor` / `--cloud-type` to pin a specific path.

[`scripts/runpod_train.py`](scripts/runpod_train.py) is pinned to H200 only (the recipe's bf16 + XLA + Hopper-tensor-core math depends on it). The pod is auto-pinned to the volume's data center via the SDK; just provide `VOLUME_ID`.

### Volume size

Default is 100 GB which is **tight** — the asl-signs raw zip (~37 GB) + extracted parquets (~41 GB) + extracted .npy cache (~31 GB) ≈ 109 GB. Resize to 150 GB before extract:

```python
# one-off
from scripts.runpod_extract_fanout import RunpodREST
import os
rest = RunpodREST(os.environ['RUNPOD_API_KEY'])
rest._req('PATCH', f'/networkvolumes/{VOLUME_ID}', json={'size': 150})
```

### RunPod S3 env-var names are intentionally swapped

`.env` ships:

```
RUNPOD_S3_KEY          = <access key>   (looks like user_3CZ...)
RUNPOD_S3_ACCESS_KEY   = <secret>       (looks like rps_4FY...)
```

The names are swapped relative to what they mean — the runtime reads them this way. Endpoint: `https://s3api-<dc>.runpod.io`, region matches the dc, bucket = volume id. Use `signature_version='s3v4'` and `addressing_style='path'`. Lets you read/inspect the volume from boto3 without spinning up a diagnostic pod.

Note: the RunPod S3 leaf-listing for MooseFS-backed volumes can return `0 keys` for prefixes that DO contain files (a known quirk). For verifying a populated cache, prefer SSH'ing into a pod with the volume mounted and `find /workspace/cache/kaggle_islr -name '*.npy' | wc -l`.

---

## Apple Silicon notes

`requirements.txt` ships `tensorflow==2.15.1` for non-Linux. That works on M-series CPU and is fine for the demo (~15 ms inference per window). For Metal GPU acceleration, swap the non-Linux line to:

```
tensorflow-macos==2.15.0
tensorflow-metal==1.1.0
```

The pod-side install always uses `tensorflow[and-cuda]==2.15.1` per the `sys_platform == "linux"` marker.

No `tensorflow-addons` dependency. The published hoyso48 recipe used `tfa.optimizers.{RectifiedAdam, Lookahead}`; we substituted `tf.keras.optimizers.AdamW` (native, XLA-clean) because tfa is in maintenance mode and the Lookahead wrapper is incompatible with `jit_compile=True` under TF 2.15 (its `sma_threshold` resource lands on CPU and XLA refuses to read it from a GPU train step).

---

## Validation

```bash
make test                              # 19 unit tests, ~1 sec, CPU only
```

`tests/` contains:

- [`test_contract.py`](tests/test_contract.py) — 15 unit tests for the inference state machine (no TF dependency).
- [`test_kaggle_islr_loader.py`](tests/test_kaggle_islr_loader.py) — 4 regression tests guarding (a) `parquet_to_tensor` produces the canonical (T, 543, 3) layout in [Pose, Face, LHand, RHand] order with NaNs preserved, and (b) the Kaggle-sign → disk-gloss map pairs by prediction index, not by JSON insertion order.

Locally I also exercise the new model end-to-end on synthetic data (model build, AWP train_step, OneCycleLR schedule, Preprocess, augment_fn) — those checks live as one-liners in the PR description rather than pinned tests because they require TF which we don't want in the test suite's CPU-only critical path.

---

## Known follow-ups (deliberately out of scope here)

- [`src/realtime_demo.py`](src/realtime_demo.py), [`src/calibrate.py`](src/calibrate.py): use the OLD model I/O contract (`[feats, mask]` two-tensor input). They are import-broken under the new single-tensor model and need rewiring before they work again. Tracked as a follow-up.
- 4-seed ensemble — the published submission averages 4 seeds (42, 43, 44, 45) over the full dataset. Single seed first; revisit once this run is solid.
- 2nd-place port (PyTorch + EfficientNet + DeBERTa). Major code addition; revisit only if the 1st-place reproduction is solid.
- TFLite export. The original was for mobile; we just want the H200 checkpoint.
- Cross-dataset broad/tight head-swap: the loaders ([`src/data/asl_citizen_loader.py`](src/data/asl_citizen_loader.py), [`src/data/wlasl_kaggle_loader.py`](src/data/wlasl_kaggle_loader.py), [`src/data/wlasl_raw_loader.py`](src/data/wlasl_raw_loader.py)) and gloss alias resolver ([`src/data/gloss_aliases.py`](src/data/gloss_aliases.py)) remain in the repo as importable modules but are no longer wired into any active config; can be pruned later if not needed.

---

## Migration notes

- **Single-source-of-truth README** (this file). No `docs/` packet — everything operationally important is here.
- **All credentials via `.env`** (gitignored). Copy `.env.example` and fill.
- **Heavy artifacts live on the RunPod volume**, not in the repo. The only PopSign artifacts tracked locally are `data/vocab/kaggle_islr.json` (250-class vocab in prediction-index order) and `data/splits/kaggle_islr.json` (~1 KB; 13/4/4 signer split).
- **No installable package**: the repo is run as `python -m src.<module>` from the repo root, driven by the [Makefile](Makefile). If you want a `pyproject.toml` install in the new repo, the `src/` layout is already set up for it.
- **Python 3.10 / 3.11 only** — TF 2.15 + MediaPipe 0.10.9 constraint.

---

## References

- 1st place writeup: <https://www.kaggle.com/competitions/asl-signs/discussion/406684>
- 1st place code (Hoyeol Sohn): <https://github.com/hoyso48/Google---Isolated-Sign-Language-Recognition-1st-place-solution>
- Vendored utilities (Apache-2.0): <https://github.com/hoyso48/tf-utils>
- Competition page: <https://www.kaggle.com/competitions/asl-signs>
- PopSign ASL v1.0 dataset (NeurIPS 2023): <https://popsign.org>
