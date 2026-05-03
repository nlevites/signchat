.PHONY: help install \
        kaggle-islr kaggle-islr-validate \
        pretrain-phase1-kaggle \
        eval demo calibrate \
        pod-kaggle-islr pod-train-phase1-kaggle \
        test clean

# Prefer the project venv python when present so `make test` (and friends) work
# from a fresh shell without forcing the user to `source .venv/bin/activate`.
# Override with `make PY=python ...` if you want the system interpreter.
PY ?= $(shell test -x .venv/bin/python && echo .venv/bin/python || echo python)

help:
	@echo "asl-classifier-model -- hoyso48 1st-place port to single-H200"
	@echo ""
	@echo "  make install         Install Python dependencies"
	@echo ""
	@echo "DATA: PopSign 250 (Google Kaggle ISLR / asl-signs)"
	@echo "  make kaggle-islr            Download + parquet->npy locally (~30 min, ~40 GB)"
	@echo "  make kaggle-islr-validate   Schema sanity check on 5 clips (no download)"
	@echo "  make pod-kaggle-islr VOLUME_ID=<id>"
	@echo "                              Same extract on a CPU pod with a network volume"
	@echo ""
	@echo "TRAIN: hoyso48 1st-place port"
	@echo "  make pretrain-phase1-kaggle Local train (300 epochs; needs Hopper-class GPU)"
	@echo "                              Optional: BATCH_SIZE=512 EPOCHS=300"
	@echo "  make pod-train-phase1-kaggle VOLUME_ID=412s5n8qkh"
	@echo "                              Full 300-epoch H200 train (~\$$16, ~4 hr)"
	@echo '                              Recommended: prefix with `caffeinate -dimsuw $$$$`.'
	@echo "                              For a smoke pass EPOCHS=5 (~\$$1, ~10 min)."
	@echo ""
	@echo "EVAL"
	@echo "  make eval CKPT=pretrained/phase1_kaggle/"
	@echo "                              Top-1 + top-5 on val_signer (held-out signers)"
	@echo "  make calibrate CKPT=pretrained/phase1_kaggle/"
	@echo "                              Fit temperature.json next to the checkpoint"
	@echo "  make demo CKPT=pretrained/phase1_kaggle/"
	@echo "                              Live webcam demo using the checkpoint"
	@echo ""
	@echo "  make test                   Run the unit-test suite (CPU-only, ~1 sec)"
	@echo "  make clean                  Remove __pycache__ and .pytest_cache"
	@echo ""
	@echo "RunPod tips:"
	@echo '  1. Prefix long pod-launch commands with `caffeinate -dimsuw $$$$`'
	@echo "     so the Mac stays awake while the pod is billing."
	@echo "  2. Pass VOLUME_ID=<id> to the pod-train target so the kaggle_islr"
	@echo "     cache is symlinked from the volume instead of rsync'd from local."

install:
	$(PY) -m pip install -r requirements.txt

# ============================================================================
# Data: PopSign 250 (Google Kaggle ISLR / asl-signs)
# ============================================================================

kaggle-islr:
	$(PY) -m src.data.kaggle_islr_loader --workers 4

kaggle-islr-validate:
	$(PY) -m src.data.kaggle_islr_loader --validate-schema

pod-kaggle-islr:
	$(PY) -u scripts/runpod_kaggle_islr.py \
	    $(if $(VOLUME_ID),--volume-id $(VOLUME_ID),) \
	    $(if $(SKIP_RSYNC),--skip-rsync,)

# ============================================================================
# Train: hoyso48 1st-place port
# ============================================================================

# Local train. Needs Hopper-class GPU for the 4-hour budget; a 4090 will work
# but at ~3-4x wall-clock and lower batch capacity (drop BATCH_SIZE to 256).
pretrain-phase1-kaggle:
	$(PY) -m src.train --config configs/pretrain_phase1_kaggle.yaml \
	    $(if $(BATCH_SIZE),--batch-size $(BATCH_SIZE),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

# Full pod-side run. VOLUME_ID symlinks the kaggle_islr cache instead of
# rsync'ing 95k npy files. Recommended: prefix with `caffeinate -dimsuw $$`.
pod-train-phase1-kaggle:
	$(PY) -u scripts/runpod_train.py --config-suffix kaggle \
	    $(if $(VOLUME_ID),--network-volume-id $(VOLUME_ID),) \
	    $(if $(EPOCHS),--epochs $(EPOCHS),)

# ============================================================================
# Eval / calibrate / demo
# ============================================================================

eval:
	@CKPT_DIR=$${CKPT:-$$(ls -td pretrained/*/ checkpoints/*/ 2>/dev/null | head -1)}; \
	if [ -z "$$CKPT_DIR" ]; then echo "ERROR: no checkpoint found; pass CKPT=path/"; exit 1; fi; \
	echo "[eval] using $$CKPT_DIR"; \
	$(PY) -m src.eval --checkpoint $$CKPT_DIR

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

test:
	$(PY) -m unittest discover -s tests -v

clean:
	find . -type d -name __pycache__ -exec rm -rf {} +
	rm -rf .pytest_cache
