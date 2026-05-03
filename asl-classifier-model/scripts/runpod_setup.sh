#!/usr/bin/env bash
# One-shot RunPod pod bootstrapper for the SignChatModel WLASL pretrain job.
#
# Run automatically by scripts/runpod_train.py after rsync'ing the repo.
# Manual users: bash scripts/runpod_setup.sh after `git clone && cd SignChatModel`.
#
# Kaggle credentials are NOT installed on the pod. The training script's caller
# must export KAGGLE_USERNAME and KAGGLE_KEY in the shell before `make wlasl`.

set -euo pipefail

echo "==> [1/3] system deps for MediaPipe / OpenCV (+ tmux for long-running pods)"
apt-get update -y
apt-get install -y --no-install-recommends \
    libgl1 libglib2.0-0 libsm6 libxext6 libxrender1 tmux

echo "==> [2/3] Python deps"
python -m pip install --upgrade pip
python -m pip install -r requirements.txt

echo "==> [3/3] GPU visibility check"
# Note: Kaggle credentials are NOT installed on the pod. scripts/runpod_train.py
# passes KAGGLE_USERNAME / KAGGLE_KEY via shell env at the `make wlasl`
# invocation, so secrets vanish with the pod. (Manual users: just `export
# KAGGLE_USERNAME=... KAGGLE_KEY=...` in this shell before `make wlasl`.)

python - <<'PY'
import sys
try:
    import tensorflow as tf
    gpus = tf.config.list_physical_devices("GPU")
    if gpus:
        print(f"    OK: TF sees {len(gpus)} GPU(s): {[g.name for g in gpus]}")
    else:
        print("    WARN: TF does not see a GPU.")
        print("    TF 2.15.1 wants CUDA 12.2; the pod template ships CUDA 12.4 which")
        print("    is forward-compatible. If detection still fails, install the cuDNN")
        print("    bundle directly:")
        print("        pip install --upgrade 'tensorflow[and-cuda]==2.15.1'")
        sys.exit(0)   # don't fail setup; user can troubleshoot
except Exception as e:
    print(f"    WARN: TensorFlow import failed: {e}")
    sys.exit(0)
PY

echo
echo "Setup complete. If invoked manually, next steps:"
echo "    export KAGGLE_USERNAME=... KAGGLE_KEY=..."
echo "    make wlasl       # download + convert MuteMotion landmarks"
echo "    make pretrain    # ~12-20 min on H100, ~30-40 min on 4090"
