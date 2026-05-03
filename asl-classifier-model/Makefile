.PHONY: help install record \
        kaggle-islr kaggle-islr-validate \
        wlasl wlasl-full wlasl-raw \
        asl-citizen asl-citizen-targeted \
        train-smoke \
        pretrain-phase1-broad pretrain-phase1-tight \
        pretrain-phase1-kaggle pretrain-phase1-kaggle-smoke \
        eval demo calibrate \
        pod-kaggle-islr \
        pod-train-phase1-kaggle pod-train-phase1-kaggle-smoke \
        pod-train-phase1-broad pod-train-phase1-tight \
        pod-extract-prep pod-extract-fanout pod-extract-merge \
        pod-extract-wlasl-raw-prep pod-extract-wlasl-raw-fanout pod-extract-wlasl-raw-merge \
        curate-vocab test clean

# Prefer the project venv python when present so `make test` (and friends) work
# from a fresh shell without forcing the user to `source .venv/bin/activate`.
# Override with `make PY=python ...` if you want the system interpreter.
PY ?= $(shell test -x .venv/bin/python && echo .venv/bin/python || echo python)

help:
	@echo "SignChatModel - common commands"
	@echo ""
	@echo "  make install         Install Python dependencies"
	@echo "  make record          Record clips from webcam (interactive)"
	@echo ""
	@echo "PRIMARY: PopSign 250 (Google Kaggle ISLR / asl-signs)"
	@echo "  make kaggle-islr            Download + parquet->npy locally (~30 min, ~40 GB)"
	@echo "  make kaggle-islr-validate   Schema sanity check on 5 clips (no download)"
	@echo "  make pod-kaggle-islr VOLUME_ID=<id>"
	@echo "                              Same extract on a CPU pod with a network volume"
	@echo "  make pretrain-phase1-kaggle Single-source 250-class training (local)"
	@echo "                              Optional: BATCH_SIZE=256 EPOCHS=30"
	@echo "  make pretrain-phase1-kaggle-smoke"
	@echo "                              2-epoch drift gate (cheap sanity run)"
	@echo "  make pod-train-phase1-kaggle VOLUME_ID=412s5n8qkh"
	@echo "                              Full PopSign train on H200 (~2 hr, ~\$$8)."
	@echo '                              Recommended: prefix with `caffeinate -dimsuw $$$$`.'
	@echo "                              VOLUME_ID symlinks the kaggle_islr cache instead"
	@echo "                              of rsync'ing 95k npy files."
	@echo "  make pod-train-phase1-kaggle-smoke VOLUME_ID=412s5n8qkh"
	@echo "                              Smoke variant of the same pod path"
	@echo "  make eval CKPT=pretrained/phase1_kaggle/"
	@echo "                              Top-1 on val_signer for the named checkpoint"
	@echo "  make calibrate CKPT=pretrained/phase1_kaggle/"
	@echo "                              Fit temperature.json next to the checkpoint"
	@echo "  make demo CKPT=pretrained/phase1_kaggle/"
	@echo "                              Live webcam demo using the checkpoint"
	@echo ""
	@echo "SECONDARY: cross-dataset broad / tight training"
	@echo "  make wlasl                  MuteMotion WLASL top-500 (~5 min)"
	@echo "  make wlasl-full             MuteMotion WLASL top-2000 (~10 min)"
	@echo "  make wlasl-raw              DIY MediaPipe extract from WLASL2000 mp4s"
	@echo "  make asl-citizen            ASL Citizen 42.8 GB + DIY MediaPipe extract"
	@echo "  make asl-citizen-targeted GLOSS_LIST=data/vocab/aslcitizen_targeted.json"
	@echo "                              Extract only the targeted gloss list"
	@echo "  make pretrain-phase1-broad  Cross-dataset broad pretrain (4-cache union)"
	@echo "  make pretrain-phase1-tight  Tight head-swap from broad to small lexicon"
	@echo "  make pod-train-phase1-broad VOLUME_ID=412s5n8qkh"
	@echo "  make pod-train-phase1-tight VOLUME_ID=412s5n8qkh"
	@echo "                              Pod-side broad/tight runs (caffeinate + volume)"
	@echo ""
	@echo "  CPU fan-out extraction (4x faster, half the cost):"
	@echo "  make pod-extract-prep VOLUME_ID=<id>"
	@echo "                              Create/reuse the network volume; pre-load videos"
	@echo "  make pod-extract-fanout VOLUME_ID=<id> [N=4]"
	@echo "                              Spin N CPU pods sharing the volume to extract"
	@echo "  make pod-extract-merge VOLUME_ID=<id>"
	@echo "                              Merge done.txt markers; rsync cache back"
	@echo ""
	@echo "  make train-smoke            Train stub MLP on smoke set (~30s sanity check)"
	@echo "  make test                   Run the unit-test suite (CPU-only, ~1 sec)"
	@echo "  make clean                  Remove __pycache__ and .pytest_cache"
	@echo ""
	@echo "RunPod tips:"
	@echo '  1. Prefix long pod-launch commands with `caffeinate -dimsuw $$$$`'
	@echo "     so the Mac stays awake while the pod is billing."
	@echo "  2. Pass VOLUME_ID=<id> to phase1 pod-train targets so caches are"
	@echo "     symlinked from the volume instead of rsync'd from local."

install:
	$(PY) -m pip install -r requirements.txt

record:
	$(PY) -m src.data.record_clips

# ============================================================================
# Primary: PopSign 250 (Google Kaggle ISLR / asl-signs)
# ============================================================================

# Local-only: download + parquet->npy convert. ~30 min, ~40 GB on disk.
# Pod equivalent: `make pod-kaggle-islr` (uses CPU pod + network volume).
kaggle-islr:
	$(PY) -m src.data.kaggle_islr_loader --workers 4

kaggle-islr-validate:
	$(PY) -m src.data.kaggle_islr_loader --validate-schema

# Download + extract Kaggle ISLR on a CPU pod with a network volume, rsync
# the cache back. ~$0.30, ~30-60 min. Reusable volume.
pod-kaggle-islr:
	$(PY) -u scripts/runpod_kaggle_islr.py \
	    $(if $(VOLUME_ID),--volume-id $(VOLUME_ID),) \
	    $(if $(SKIP_RSYNC),--skip-rsync,)

# Smoke training run on Kaggle ISLR alone (250 classes, 2 epochs, ~$3 H200).
# Validates landmark coords / no MediaPipe-version drift before mixing into
# the broad union (Option A) or staging it as pretrain (Option B).
pretrain-phase1-kaggle-smoke:
	$(PY) -m src.train --config configs/pretrain_phase1_kaggle_smoke.yaml \
	    $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE),)

# Full kaggle-only training run (single source, 250 PopSign classes, smaller
# model + n_ch=9 + max_len=160 + CutMix per the asl-signs Kaggle 1st/2nd-place
# winners). Proves the recipe end-to-end. EPOCHS env var passes through to
# `src.train --epochs N` so a smoke (--epochs 6) can run first.
pretrain-phase1-kaggle:
	$(PY) -m src.train --config configs/pretrain_phase1_kaggle.yaml \
	    $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

# Pod-side full PopSign run. VOLUME_ID symlinks the kaggle_islr cache instead
# of rsync'ing 95k npy files. Recommended: prefix with `caffeinate -dimsuw $$`
# so the Mac stays awake while the pod is billing.
pod-train-phase1-kaggle:
	$(PY) -u scripts/runpod_train.py --config-suffix kaggle \
	    $(if $(VOLUME_ID),--network-volume-id $(VOLUME_ID),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

pod-train-phase1-kaggle-smoke:
	$(PY) -u scripts/runpod_train.py --config-suffix kaggle_smoke \
	    $(if $(VOLUME_ID),--network-volume-id $(VOLUME_ID),)

# ============================================================================
# Secondary: cross-dataset broad / tight pretrain
# ============================================================================

wlasl:
	$(PY) -m src.data.wlasl_kaggle_loader --top-k 500

wlasl-full:
	$(PY) -m src.data.wlasl_kaggle_loader --top-k 2000

# DIY MediaPipe extract from raw WLASL2000 mp4s (~10 GB download, ~30-45 min
# extract on M-series). Distinct from `wlasl` / `wlasl-full` which use the
# MuteMotion pre-extracted Kaggle dataset; this one is for full 2K-gloss
# coverage AND for landmark parity with our own runtime MediaPipe config.
wlasl-raw:
	$(PY) -m src.data.wlasl_raw_loader \
	    $(if $(GLOSS_LIST),--gloss-list $(GLOSS_LIST),) \
	    $(if $(WORKERS),--workers $(WORKERS),) \
	    $(if $(TOP_K),--top-k $(TOP_K),)

asl-citizen:
	$(PY) -m src.data.asl_citizen_loader --top-k 500

asl-citizen-targeted:
	@if [ -z "$(GLOSS_LIST)" ]; then echo "ERROR: pass GLOSS_LIST=path/to/list.json"; exit 1; fi
	$(PY) -m src.data.asl_citizen_loader --gloss-list $(GLOSS_LIST) \
	    $(if $(WORKERS),--workers $(WORKERS),)

curate-vocab:
	$(PY) scripts/curate_vocab.py --analyze \
	    --cache-dirs data/cache/asl_citizen data/cache/wlasl \
	    --demo-vocab data/vocab/coffee_chat.json \
	    --backup-pool data/vocab/coffee_chat_backup.json

pretrain-phase1-broad:
	$(PY) -m src.train --config configs/pretrain_phase1_broad.yaml \
	    $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

pretrain-phase1-tight:
	$(PY) -m src.train --config configs/pretrain_phase1_tight.yaml \
	    $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE),)

pod-train-phase1-broad:
	$(PY) -u scripts/runpod_train.py --config-suffix broad \
	    $(if $(VOLUME_ID),--network-volume-id $(VOLUME_ID),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

pod-train-phase1-tight:
	$(PY) -u scripts/runpod_train.py --config-suffix tight \
	    $(if $(VOLUME_ID),--network-volume-id $(VOLUME_ID),)

pod-extract-prep:
	$(PY) -u scripts/runpod_extract_fanout.py prep-volume \
	    --volume-size 100 \
	    $(if $(VOLUME_ID),--volume-id $(VOLUME_ID),) \
	    $(if $(SOURCE_POD_ID),--source-pod-id $(SOURCE_POD_ID),) \
	    $(if $(PULL_CACHE),--pull-cache,)

pod-extract-fanout:
	$(PY) -u scripts/runpod_extract_fanout.py extract-fanout \
	    --volume-id $(VOLUME_ID) --num-shards $(or $(N),4) \
	    --cpu-flavor cpu5c --vcpu 32 --workers 16 --timeout 180 \
	    $(if $(GLOSS_LIST),--gloss-list $(GLOSS_LIST),) \
	    $(if $(PER_PARTICIPANT),--per-participant,)

pod-extract-merge:
	$(PY) -u scripts/runpod_extract_fanout.py merge-and-fetch \
	    --volume-id $(VOLUME_ID) \
	    $(if $(DATASET),--dataset $(DATASET),)

# WLASL2000 raw extraction on the same volume as ASL Citizen. The prep step
# downloads risangbaskoro/wlasl-processed (~10 GB) and optionally cleans the
# .kagglehub cache (gated on ASL Citizen videos already extracted). The
# fanout step defaults to N=1 because WLASL2000 is small enough that one
# 32-vCPU pod finishes in ~30-45 min.
pod-extract-wlasl-raw-prep:
	@if [ -z "$(VOLUME_ID)" ]; then echo "ERROR: pass VOLUME_ID=<volume id>"; exit 1; fi
	$(PY) -u scripts/runpod_extract_fanout.py prep-volume \
	    --dataset wlasl_raw --volume-id $(VOLUME_ID) \
	    $(if $(NO_CLEAN_KAGGLEHUB),,--clean-kagglehub)

pod-extract-wlasl-raw-fanout:
	@if [ -z "$(VOLUME_ID)" ]; then echo "ERROR: pass VOLUME_ID=<volume id>"; exit 1; fi
	$(PY) -u scripts/runpod_extract_fanout.py extract-fanout \
	    --dataset wlasl_raw --volume-id $(VOLUME_ID) \
	    --num-shards $(or $(N),1) --cpu-flavor cpu5c --vcpu 32 \
	    --workers 16 --timeout 90 \
	    $(if $(GLOSS_LIST),--gloss-list $(GLOSS_LIST),) \
	    --per-participant

pod-extract-wlasl-raw-merge:
	@if [ -z "$(VOLUME_ID)" ]; then echo "ERROR: pass VOLUME_ID=<volume id>"; exit 1; fi
	$(PY) -u scripts/runpod_extract_fanout.py merge-and-fetch \
	    --dataset wlasl_raw --volume-id $(VOLUME_ID)

# ============================================================================
# Eval / calibrate / demo
# ============================================================================

# Eval / calibrate / demo all default to the freshest checkpoint dir under
# pretrained/ (preferred for PopSign + phase1 runs) then checkpoints/. Pass
# CKPT=path/to/ckpt_dir/ to pin a specific run.
eval:
	@CKPT_DIR=$${CKPT:-$$(ls -td pretrained/*/ checkpoints/*/ 2>/dev/null | head -1)}; \
	if [ -z "$$CKPT_DIR" ]; then echo "ERROR: no checkpoint found; pass CKPT=path/"; exit 1; fi; \
	echo "[eval] using $$CKPT_DIR"; \
	$(PY) -m src.eval --checkpoint $$CKPT_DIR

# Calibration: fit a scalar temperature T on val_signer; write temperature.json
# next to the checkpoint. Used by realtime_demo.py to honest-up softmax for the
# downstream LLM. ~30 sec, no GPU needed.
calibrate:
	@if [ -z "$(CKPT)" ]; then echo "ERROR: pass CKPT=path/to/checkpoint_dir/"; exit 1; fi
	$(PY) -m src.calibrate --checkpoint $(CKPT)

demo:
	@CKPT_DIR=$${CKPT:-$$(ls -td pretrained/*/ checkpoints/*/ 2>/dev/null | head -1)}; \
	if [ -z "$$CKPT_DIR" ]; then echo "ERROR: no checkpoint found; pass CKPT=path/"; exit 1; fi; \
	echo "[demo] using $$CKPT_DIR"; \
	$(PY) -m src.realtime_demo --checkpoint $$CKPT_DIR

# ============================================================================
# Tests / housekeeping
# ============================================================================

train-smoke:
	$(PY) -m src.train --config configs/smoke.yaml

test:
	$(PY) -m unittest discover -s tests -v

clean:
	find . -type d -name __pycache__ -exec rm -rf {} +
	rm -rf .pytest_cache
