"""Land + convert Google Kaggle ISLR (asl-signs / PopSign) on a RunPod CPU pod.

The asl-signs dataset is already MediaPipe Holistic landmarks (no video step
needed), so the entire pipeline fits on one cheap CPU pod:

    1. Provision a 32 vCPU 5GHz CPU pod with a network volume mounted
       (default ``--volume-size 100`` GB; reuse the existing volume by
       passing ``--volume-id``).
    2. Install kagglehub; ``kagglehub.competition_download('asl-signs')``
       (~40 GB) onto /workspace/datasets/asl-signs (the network volume).
    3. ``python -m src.data.kaggle_islr_loader --source-dir
       /workspace/datasets/asl-signs --validate-schema`` to fail fast on any
       MediaPipe-version drift.
    4. Run the loader full extraction (parquet -> .npy) into
       /workspace/cache/kaggle_islr (also on the volume).
    5. ``rsync`` the cache back to local data/cache/kaggle_islr/.
    6. Terminate the pod (network volume preserved).

Total: ~$0.30, ~30-60 min depending on volume IO. Pod is destroyed on exit;
the network volume is preserved for the training pod to reuse.

Usage:
    python -u scripts/runpod_kaggle_islr.py
    python -u scripts/runpod_kaggle_islr.py --volume-id <existing> --keep-cache-on-volume
    python -u scripts/runpod_kaggle_islr.py --skip-rsync   # leave cache on volume only

Cleanup invariant: pod terminates from finally + atexit + signal handlers.
The network volume is NEVER auto-deleted by this script (call --delete-volume
explicitly to nuke it).

The local equivalent ``make kaggle-islr`` runs the same loader on the M4
itself; useful when ~50 GB of free disk + ~2 hr of background extraction is
acceptable. The pod path is faster (5 GHz cores + 32 vCPUs) and frees the M4
for development.
"""

from __future__ import annotations

import argparse
import atexit
import os
import shlex
import signal
import subprocess
import sys
import time
from pathlib import Path

# Reuse the proven primitives from the GPU-pod orchestrator.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runpod_train import (  # type: ignore
    Credentials,
    EphemeralKey,
    SSHSession,
    cleanup_ephemeral_key,
    load_credentials,
    make_ephemeral_keypair,
    terminate_pod,
)
from runpod_extract_fanout import (  # type: ignore
    CPU_POD_IMAGE,
    DEFAULT_CPU_FLAVOR,
    PREFERRED_DCS,
    RunpodREST,
    get_or_create_volume,
    wait_for_pod_ready,
)


def _scp_down(remote_host: str, remote_port: int, key_path: Path,
              remote_path: str, local_path: Path) -> int:
    """rsync remote_path/ -> local_path/ via scp/rsync over the ephemeral key."""
    local_path.mkdir(parents=True, exist_ok=True)
    cmd = [
        "rsync", "-avz", "--partial",
        "-e", (f"ssh -i {shlex.quote(str(key_path))} -p {remote_port} "
               "-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null "
               "-o LogLevel=ERROR"),
        f"root@{remote_host}:{remote_path}/",
        f"{local_path}/",
    ]
    print(f"[kaggle-islr] rsync down: {' '.join(cmd)}")
    return subprocess.call(cmd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--volume-id", default=None,
                        help="reuse an existing network volume "
                             "(default: create a new one tagged signchat-kaggle-islr)")
    parser.add_argument("--volume-size", type=int, default=100,
                        help="GB if creating a new volume (default 100). "
                             "The full asl-signs cache fits comfortably in 100 GB; "
                             "size up via REST PATCH if you'll co-locate other datasets.")
    parser.add_argument("--vcpu", type=int, default=16,
                        help="CPU pod vCPU count (default 16; 8 workers is enough)")
    parser.add_argument("--cpu-flavor", default=None,
                        help="CPU flavor id (default falls back through "
                             "['cpu5c', 'cpu3c', 'cpu5g'] until one is available; "
                             "cpu5c is fastest, cpu3c is most-available)")
    parser.add_argument("--cloud-type", default=None,
                        choices=("SECURE", "COMMUNITY"),
                        help="cloud tier (default: try SECURE then COMMUNITY). "
                             "COMMUNITY tends to have more CPU availability.")
    parser.add_argument("--workers", type=int, default=8,
                        help="parquet->npy conversion workers (default 8)")
    parser.add_argument("--cache-on-volume",
                        default="/workspace/cache/kaggle_islr",
                        help="where on the volume to write the .npy cache")
    parser.add_argument("--dataset-on-volume",
                        default="/workspace/datasets/asl-signs",
                        help="where on the volume to extract the asl-signs download")
    parser.add_argument("--skip-rsync", action="store_true",
                        help="don't rsync cache back to local; keep it on the volume only")
    parser.add_argument("--keep-pod", action="store_true",
                        help="don't terminate pod on exit (debugging only)")
    parser.add_argument("--wall-timeout-min", type=int, default=120,
                        help="abort if total wall-clock exceeds this many minutes "
                             "(default 120). Mostly safety against a stuck download "
                             "or a runaway extraction.")
    parser.add_argument("--tag", default="kaggle-islr",
                        help="pod/volume name tag (default 'kaggle-islr')")
    parser.add_argument("--gpu", default=None,
                        help="Provision a GPU pod (this exact gpu_type_id) "
                             "instead of CPU. Use as a fallback when CPU + "
                             "volume capacity is depleted globally; e.g. "
                             "'NVIDIA H200'. The GPU is unused for the "
                             "extract itself - it's just an expensive CPU box.")
    args = parser.parse_args()

    creds = load_credentials()
    rest = RunpodREST(creds.runpod_key)

    vol = get_or_create_volume(rest, args.volume_id, args.volume_size,
                               PREFERRED_DCS, args.tag)
    volume_id = vol["id"]
    dc_id = vol.get("dataCenterId")
    print(f"[kaggle-islr] volume={volume_id} dc={dc_id}")

    ephemeral = make_ephemeral_keypair()
    atexit.register(cleanup_ephemeral_key, ephemeral)

    pod_id: str | None = None

    def _cleanup():
        if pod_id and not args.keep_pod:
            terminate_pod(pod_id, creds.runpod_key)

    atexit.register(_cleanup)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: (_cleanup(), sys.exit(130)))

    try:
        if args.gpu:
            # GPU pod fallback: use when CPU+volume capacity is depleted
            # globally (RunPod periodically goes to zero CPU availability for
            # volume-attached pods). The GPU is unused for the extract; we
            # just need a box that can mount the volume.
            import runpod as _rp
            _rp.api_key = creds.runpod_key
            print(f"[kaggle-islr] provisioning GPU pod ({args.gpu})...")
            pod_resp = _rp.create_pod(
                name=f"signchat-{args.tag}",
                image_name=CPU_POD_IMAGE,
                gpu_type_id=args.gpu,
                cloud_type="SECURE",
                gpu_count=1,
                container_disk_in_gb=50,
                volume_in_gb=0,
                support_public_ip=True,
                start_ssh=True,
                ports="22/tcp",
                env={
                    "PUBLIC_KEY": ephemeral.public_text,
                    "KAGGLE_USERNAME": creds.kaggle_user,
                    "KAGGLE_KEY": creds.kaggle_key,
                },
                network_volume_id=volume_id,
                volume_mount_path="/workspace",
            )
        else:
            # Try the user-specified flavor + cloud first, then fall back. RunPod
            # CPU capacity per-DC + cloudType fluctuates; cpu5c (5GHz) is
            # preferred for IO-bound parquet->npy conversion but smaller cpu3c
            # is more reliably available; COMMUNITY tier tends to have more
            # capacity than SECURE.
            flavor_candidates = (
                [args.cpu_flavor] if args.cpu_flavor else ["cpu5c", "cpu3c", "cpu5g"]
            )
            cloud_candidates = (
                [args.cloud_type] if args.cloud_type else ["SECURE", "COMMUNITY"]
            )
            pod_resp = None
            last_err: Exception | None = None
            for cloud in cloud_candidates:
                for flavor in flavor_candidates:
                    print(f"[kaggle-islr] provisioning {args.vcpu} vCPU pod "
                          f"({flavor}, {cloud})...")
                    try:
                        # cpu3c-4 caps container disk at 40 GB; the asl-signs dataset
                        # lives on the network volume not the container disk, so 40 GB
                        # is plenty for OS + apt + a small kagglehub temp cache.
                        pod_resp = rest.create_cpu_pod(
                            name=f"signchat-{args.tag}",
                            vcpu=args.vcpu,
                            image=CPU_POD_IMAGE,
                            cpu_flavor=flavor,
                            network_volume_id=volume_id,
                            env={
                                "PUBLIC_KEY": ephemeral.public_text,
                                "KAGGLE_USERNAME": creds.kaggle_user,
                                "KAGGLE_KEY": creds.kaggle_key,
                            },
                            container_disk_gb=40,
                            data_center_ids=[dc_id] if dc_id else None,
                            cloud_type=cloud,
                        )
                        break
                    except Exception as e:
                        print(f"[kaggle-islr] {flavor}/{cloud} failed: {e}")
                        last_err = e
                if pod_resp is not None:
                    break
            if pod_resp is None:
                raise RuntimeError(
                    f"could not provision CPU pod across "
                    f"flavors={flavor_candidates} clouds={cloud_candidates}. "
                    f"Last error: {last_err}"
                )
        pod_id = pod_resp["id"]
        print(f"[kaggle-islr] pod_id={pod_id}")
        host, port = wait_for_pod_ready(rest, pod_id, timeout_s=480)
        ssh = SSHSession(host, port, key_path=ephemeral.private_path)
        ssh.wait_ready()

        wall_deadline = time.time() + args.wall_timeout_min * 60

        def _check_wall():
            if time.time() > wall_deadline:
                raise TimeoutError(
                    f"wall-clock budget ({args.wall_timeout_min} min) exceeded")

        # 1. Install dependencies (rsync first so step 2 can rsync the repo up).
        print("[kaggle-islr] installing tmux, rsync, kagglehub, pandas, pyarrow...")
        ssh.run(
            "apt-get update -q >/dev/null 2>&1 && "
            "apt-get install -y -q tmux rsync >/dev/null 2>&1 && "
            "pip install -q kagglehub==0.3.6 pandas==2.2.0 pyarrow tqdm",
            on_line=lambda line: print(line, end=""),
        )
        _check_wall()

        # 2. Rsync the local repo up so the loader module is available.
        # We previously git-cloned from github.com/nlevites/signchat-model which
        # 404s; rsync-up is the same primitive runpod_train.py uses and is
        # deterministic regardless of remote-repo state.
        print("[kaggle-islr] rsync'ing repo up to /workspace/SignChatModel/...")
        ssh.rsync_up(
            local="./",
            remote="/workspace/SignChatModel/",
            excludes=[".git", ".venv", "venv", "__pycache__",
                      "data/cache/", "data/raw/", "pretrained/",
                      "checkpoints/", "pod_session.log",
                      ".env", "kaggle.json"],
        )
        _check_wall()

        # 3. Download dataset to volume via kagglehub competition_download.
        # IMPORTANT: KAGGLEHUB_CACHE points at the volume so the 40 GB lands
        # on the network volume (~100-300 GB depending on volume size) rather
        # than the 50 GB container disk. Wrapped in tmux so a transient SSH
        # drop doesn't kill the download.
        print("[kaggle-islr] downloading asl-signs (~40 GB) into volume...")
        # Explicitly export KAGGLE creds inside the bash that runs python -c.
        # The pod's create_cpu_pod env-var injection turned out to NOT propagate
        # KAGGLE_USERNAME / KAGGLE_KEY through the tmux subshell on this image
        # (kagglehub raised UnauthenticatedError on the first attempt). Inlining
        # the export here makes the auth deterministic.
        download_script = f"""
mkdir -p /workspace/.kagglehub {args.dataset_on_volume}
export KAGGLEHUB_CACHE=/workspace/.kagglehub
export KAGGLE_USERNAME={shlex.quote(creds.kaggle_user)}
export KAGGLE_KEY={shlex.quote(creds.kaggle_key)}
python -c "
import kagglehub, shutil
from pathlib import Path
p = Path(kagglehub.competition_download('asl-signs'))
print('[kaggle-islr] kagglehub returned:', p)
src = p / 'train.csv'
if not src.exists():
    nested = list(p.glob('**/train.csv'))
    if nested:
        p = nested[0].parent
        src = p / 'train.csv'
print('[kaggle-islr] dataset root on download:', p)
dst = Path('{args.dataset_on_volume}')
dst.mkdir(parents=True, exist_ok=True)
import os
for entry in p.iterdir():
    target = dst / entry.name
    if target.exists(): continue
    if entry.is_dir():
        shutil.copytree(entry, target)
    else:
        shutil.copy2(entry, target)
print('[kaggle-islr] copied to:', dst)
print('[kaggle-islr] size:', sum(f.stat().st_size for f in dst.rglob('*') if f.is_file()) // (1024**3), 'GB')
"
"""
        rc = ssh.run_in_tmux(
            name="signchat-kaggle-dl",
            cmd=download_script.strip(),
            work_dir="/workspace",
            on_line=lambda line: print(line, end=""),
        )
        if rc != 0:
            raise RuntimeError(f"kagglehub competition_download failed (exit {rc})")
        _check_wall()

        # 4. Validate schema before any extraction work.
        print("[kaggle-islr] validating schema...")
        rc = ssh.run(
            f"cd /workspace/SignChatModel && "
            f"python -m src.data.kaggle_islr_loader "
            f"--source-dir {args.dataset_on_volume} --validate-schema",
            on_line=lambda line: print(line, end=""),
        )
        if rc != 0:
            raise RuntimeError(f"schema validation failed (exit {rc}); see output above")
        _check_wall()

        # 5. Run full extraction.
        print("[kaggle-islr] extracting parquet -> .npy "
              f"({args.workers} workers)...")
        extract_script = (
            f"cd /workspace/SignChatModel && "
            f"python -m src.data.kaggle_islr_loader "
            f"--source-dir {args.dataset_on_volume} "
            f"--out-dir {args.cache_on_volume} "
            f"--workers {args.workers} "
            f"--write-targeted-vocab data/vocab/kaggle_islr.json "
            # write-targeted-vocab exits early; run conversion in second invocation
            f"&& python -m src.data.kaggle_islr_loader "
            f"--source-dir {args.dataset_on_volume} "
            f"--out-dir {args.cache_on_volume} "
            f"--workers {args.workers}"
        )
        rc = ssh.run_in_tmux(
            name="signchat-kaggle-extract",
            cmd=extract_script,
            work_dir="/workspace/SignChatModel",
            on_line=lambda line: print(line, end=""),
        )
        if rc != 0:
            raise RuntimeError(f"extraction failed (exit {rc})")
        _check_wall()

        # 6. Optional rsync down.
        if not args.skip_rsync:
            local_cache = Path("data/cache/kaggle_islr")
            print(f"[kaggle-islr] rsync {args.cache_on_volume} -> {local_cache}")
            rc = _scp_down(host, port, ephemeral.private_path,
                           args.cache_on_volume, local_cache)
            if rc != 0:
                print(f"[kaggle-islr] WARN rsync exited {rc}; "
                      f"cache still on volume {volume_id}", file=sys.stderr)
            else:
                print(f"[kaggle-islr] cache landed at {local_cache}")
            # Pull splits + vocab.json sidecar from the regenerated locations
            # in the repo too, so local has matching auth files.
            for src, dst in [
                (f"/workspace/SignChatModel/data/splits/kaggle_islr.json",
                 Path("data/splits/kaggle_islr.json")),
                (f"/workspace/SignChatModel/data/vocab/kaggle_islr.json",
                 Path("data/vocab/kaggle_islr.json")),
            ]:
                dst.parent.mkdir(parents=True, exist_ok=True)
                cmd = [
                    "scp", "-i", str(ephemeral.private_path), "-P", str(port),
                    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
                    "-o", "LogLevel=ERROR",
                    f"root@{host}:{src}", str(dst),
                ]
                if subprocess.call(cmd) == 0:
                    print(f"[kaggle-islr] pulled {dst}")

        print(f"\n[kaggle-islr] DONE.")
        print(f"  - dataset on volume: {args.dataset_on_volume}  (preserved)")
        print(f"  - cache on volume:   {args.cache_on_volume}  (preserved)")
        print(f"  - volume_id:         {volume_id}  (re-use for smoke train)")
        if not args.skip_rsync:
            print(f"  - cache local:       data/cache/kaggle_islr/")
        return 0
    finally:
        _cleanup()


if __name__ == "__main__":
    sys.exit(main() or 0)
