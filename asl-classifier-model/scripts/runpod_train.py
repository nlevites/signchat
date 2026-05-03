"""Fully automated phase1 train on a freshly-provisioned RunPod H200.

Provisions an H200 GPU pod, rsyncs the repo + (optionally) data/cache/ +
pretrained/ up, runs ``make pretrain-phase1-<suffix>`` in tmux, scps the
trained weights back, and terminates the pod.

Modes (via the required ``--config-suffix``):

    kaggle         PopSign 250 single-source full train (~$8, ~2 hr).
    kaggle_smoke   PopSign 250 2-epoch drift gate (~$3, ~45 min).
    broad          Cross-dataset broad pretrain (~$16-23, ~4-6 hr).
    tight          Tight head-swap from broad (~$6, ~1.5 hr). Requires
                   pretrained/phase1_broad/ to exist locally; that
                   checkpoint is rsync'd up so resume_from resolves.

Examples:
    # Recommended: prefix with caffeinate so the Mac stays awake while
    # the pod is billing.
    caffeinate -dimsuw $$ python -u scripts/runpod_train.py \\
        --config-suffix kaggle --network-volume-id 412s5n8qkh

    caffeinate -dimsuw $$ python -u scripts/runpod_train.py \\
        --config-suffix broad --network-volume-id 412s5n8qkh --epochs 6

Cost guardrails (defaults; override via CLI):
    - Wall-clock timeout: per-mode (kaggle 180 min, kaggle_smoke 90, etc.)
    - Idle (no stdout) timeout: 60 min
    - Periodic cost-so-far ping every 5 min

Cleanup:
    Pods are terminated from finally + atexit + signal handlers. Even on
    SIGKILL of this script, the worst case is one pod hour to spot via the
    RunPod console.
"""

from __future__ import annotations

import argparse
import atexit
import json
import os
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional


# Phase 1 train modes target H200 ONLY. Reasoning: the bf16 + XLA +
# Hopper-tensor-core speedup math assumes Hopper-class hardware with
# H200's higher memory bandwidth. Falling back to a slower GPU would
# silently break the cost/wall-time predictions the user agreed to.
# If H200 capacity is unavailable in the requested DC, fail loudly so
# the user can retry later or override with --gpu "NVIDIA H100 80GB HBM3"
# manually.
GPU_FALLBACK_PHASE1 = ["NVIDIA H200"]

# Per-GPU batch size override.
BATCH_BY_GPU: dict[str, int] = {
    "NVIDIA H200":             256,   # 141 GB VRAM
    "NVIDIA H100 80GB HBM3":   256,
    "NVIDIA A100 80GB PCIe":   256,
    "NVIDIA A100-SXM4-40GB":   192,
    "NVIDIA GeForce RTX 4090": 128,
}

# Hourly cost estimate per GPU (USD). RunPod on-demand prices fluctuate; these
# are 2025-2026 ballparks used only to print a "running cost" estimate. Real
# billing is whatever RunPod charges.
COST_PER_HOUR: dict[str, float] = {
    "NVIDIA H200":             3.99,   # RunPod community/secure ballpark
    "NVIDIA H100 80GB HBM3":   2.79,
    "NVIDIA A100 80GB PCIe":   1.89,
    "NVIDIA A100-SXM4-40GB":   1.19,
    "NVIDIA GeForce RTX 4090": 0.54,
}

POD_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"
CONTAINER_DISK_GB_DEFAULT = 50
SSH_BACKOFF_SCHEDULE = [5, 10, 20, 40, 80]   # seconds; 5 attempts total
LOG_FILE = Path("pod_session.log")


# --------------------------------------------------------------------------- creds

@dataclass
class Credentials:
    runpod_key: str
    kaggle_user: str
    kaggle_key: str


def load_credentials() -> Credentials:
    try:
        from dotenv import load_dotenv
    except ImportError:
        sys.exit("ERROR: python-dotenv not installed. Run `pip install python-dotenv`.")

    load_dotenv()
    runpod_key = os.environ.get("RUNPOD_API_KEY")
    if not runpod_key:
        sys.exit("ERROR: RUNPOD_API_KEY not set. Add it to .env or export it in your shell.")

    kaggle_user = os.environ.get("KAGGLE_USERNAME")
    kaggle_key = os.environ.get("KAGGLE_KEY")
    if not (kaggle_user and kaggle_key):
        kj = Path.home() / ".kaggle" / "kaggle.json"
        # Fall back to a repo-local kaggle.json if present.
        if not kj.exists():
            local_kj = Path("kaggle.json")
            if local_kj.exists():
                kj = local_kj
        if not kj.exists():
            sys.exit(
                "ERROR: Kaggle creds not found. Either:\n"
                "  - place kaggle.json at ~/.kaggle/kaggle.json (chmod 600), OR\n"
                "  - export KAGGLE_USERNAME and KAGGLE_KEY env vars.\n"
                "Get a token from https://www.kaggle.com/settings."
            )
        try:
            data = json.loads(kj.read_text())
            kaggle_user = data["username"]
            kaggle_key = data["key"]
        except (json.JSONDecodeError, KeyError) as e:
            sys.exit(f"ERROR: {kj} malformed: {e}")

    return Credentials(runpod_key=runpod_key, kaggle_user=kaggle_user, kaggle_key=kaggle_key)


# --------------------------------------------------------------------------- pod

@dataclass
class Pod:
    id: str
    gpu_name: str
    ssh_host: str
    ssh_port: int
    started_at: float


def provision_pod(creds: Credentials, gpu_override: Optional[str], tag: str,
                  public_key: str, fallback: list[str], disk_gb: int,
                  network_volume_id: Optional[str] = None,
                  volume_mount_path: str = "/runpod-volume") -> Pod:
    """Provision a GPU pod via the runpod SDK GraphQL endpoint.

    `network_volume_id` (optional): if set, the pod is pinned to the volume's
    datacenter. The SDK's create_pod auto-resolves the data_center_id from the
    volume id via get_user(). Default `volume_mount_path="/runpod-volume"`
    matches the SDK default; pass `/workspace` to align with the orchestrator's
    expectation that a shared volume lives there.
    """
    import runpod
    runpod.api_key = creds.runpod_key

    candidates = [gpu_override] if gpu_override else fallback
    last_err: Optional[Exception] = None
    for gpu in candidates:
        try:
            print(f"[runpod] requesting pod with GPU '{gpu}' ({disk_gb} GB disk)"
                  f"{f' + volume {network_volume_id}' if network_volume_id else ''}...")
            pod_resp = runpod.create_pod(
                name=f"signchat-pretrain-{tag}",
                image_name=POD_IMAGE,
                gpu_type_id=gpu,
                cloud_type="SECURE",
                gpu_count=1,
                container_disk_in_gb=disk_gb,
                volume_in_gb=0,
                support_public_ip=True,
                start_ssh=True,
                ports="22/tcp",
                # PUBLIC_KEY is the env var RunPod's pytorch image consumes to
                # populate ~/.ssh/authorized_keys at boot. Without it, sshd is
                # up but every connection gets "Permission denied (publickey)".
                env={"PUBLIC_KEY": public_key},
                network_volume_id=network_volume_id,
                volume_mount_path=volume_mount_path,
            )
            pod_id = pod_resp["id"]
            print(f"[runpod] provisioned pod id={pod_id} on '{gpu}'")
            return Pod(id=pod_id, gpu_name=gpu, ssh_host="", ssh_port=0, started_at=time.time())
        except Exception as e:
            print(f"[runpod] GPU '{gpu}' failed: {e}")
            last_err = e
            continue
    raise RuntimeError(f"could not provision any GPU from fallback list. Last error: {last_err}")


def wait_for_running(pod: Pod, timeout_s: int = 240) -> Pod:
    """Poll until the pod is RUNNING and an SSH endpoint is exposed."""
    import runpod
    print(f"[runpod] waiting for pod {pod.id} to come up (max {timeout_s}s)...")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        info = runpod.get_pod(pod.id)
        runtime = info.get("runtime") or {}
        status = info.get("desiredStatus") or info.get("status") or "UNKNOWN"
        ports = runtime.get("ports") or []
        ssh_port = next((p for p in ports if p.get("privatePort") == 22 and p.get("isIpPublic")), None)
        if status == "RUNNING" and ssh_port:
            pod.ssh_host = ssh_port["ip"]
            pod.ssh_port = int(ssh_port["publicPort"])
            print(f"[runpod] pod ready: ssh root@{pod.ssh_host} -p {pod.ssh_port}")
            return pod
        time.sleep(5)
    raise TimeoutError(f"pod {pod.id} did not reach RUNNING state in {timeout_s}s")


def terminate_pod(pod_id: str, runpod_key: str):
    """Idempotent: safe to call multiple times. Logged failures don't raise."""
    if not pod_id:
        return
    try:
        import runpod
        runpod.api_key = runpod_key
        runpod.terminate_pod(pod_id)
        print(f"[runpod] terminated pod {pod_id}")
    except Exception as e:
        print(f"[runpod] WARN failed to terminate pod {pod_id}: {e}", file=sys.stderr)
        print(f"[runpod] please verify in https://www.runpod.io/console/pods", file=sys.stderr)


# --------------------------------------------------------------------------- experiments.csv

def _merge_experiments_csv(pod_csv: Path, local_csv: Path):
    """Append rows from `pod_csv` into `local_csv`, skipping the header line if
    `local_csv` already exists. Idempotent on re-runs (run_ids are timestamped
    so there's no real duplication, just possible repeats if you re-merge the
    same file twice)."""
    if not pod_csv.exists() or pod_csv.stat().st_size == 0:
        return
    pod_lines = pod_csv.read_text().splitlines()
    if not pod_lines:
        return
    if not local_csv.exists() or local_csv.stat().st_size == 0:
        local_csv.write_text(pod_csv.read_text())
        return
    # Skip the pod's header line
    rows = pod_lines[1:]
    if not rows:
        return
    with local_csv.open("a") as f:
        for r in rows:
            if r.strip():
                f.write(r + "\n")


# --------------------------------------------------------------------------- ephemeral ssh

@dataclass
class EphemeralKey:
    private_path: Path
    public_text: str
    temp_dir: Path


def make_ephemeral_keypair() -> EphemeralKey:
    """Generate a fresh ed25519 keypair in a temp dir, just for this pod.

    The public key gets registered on the pod via the PUBLIC_KEY env var
    RunPod's image looks for; the private key is used by ssh/rsync/scp.
    Both are deleted in the cleanup path so no key persists past the run.
    """
    tmp = Path(tempfile.mkdtemp(prefix="signchat-pod-"))
    priv = tmp / "id_ed25519"
    rc = subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(priv),
         "-C", "signchat-ephemeral", "-q"],
        capture_output=True, text=True,
    )
    if rc.returncode != 0:
        shutil.rmtree(tmp, ignore_errors=True)
        raise RuntimeError(f"ssh-keygen failed: {rc.stderr}")
    pub_text = (tmp / "id_ed25519.pub").read_text().strip()
    print(f"[ssh] generated ephemeral keypair at {priv}")
    return EphemeralKey(private_path=priv, public_text=pub_text, temp_dir=tmp)


def cleanup_ephemeral_key(key: Optional[EphemeralKey]):
    if key and key.temp_dir.exists():
        shutil.rmtree(key.temp_dir, ignore_errors=True)
        print(f"[ssh] removed ephemeral keypair from {key.temp_dir}")


# --------------------------------------------------------------------------- ssh

class SSHSession:
    """Subprocess-backed SSH wrapper with line-by-line stdout streaming."""

    def __init__(self, host: str, port: int, key_path: Path, log_path: Path = LOG_FILE):
        self.host = host
        self.port = port
        self.key_path = key_path
        self.log_path = log_path
        self._common_opts = [
            "-i", str(key_path),
            "-o", "IdentitiesOnly=yes",
            "-o", "StrictHostKeyChecking=no",
            "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR",
            # Keepalive: send a no-op packet every 30s; tolerate 10 missed
            # responses (= 5 min of network silence) before declaring the
            # connection dead. Without these, a brief network blip mid-train
            # makes ssh return 255 -> cleanup_guard terminates the pod even
            # though the tmux training session is still happily running.
            "-o", "ServerAliveInterval=30",
            "-o", "ServerAliveCountMax=10",
            "-p", str(port),
        ]

    def wait_ready(self):
        """SSH + retry with exponential backoff until we can land a command."""
        for i, delay in enumerate(SSH_BACKOFF_SCHEDULE):
            print(f"[ssh] connect attempt {i+1}/{len(SSH_BACKOFF_SCHEDULE)} in {delay}s...")
            time.sleep(delay)
            try:
                rc = subprocess.run(
                    ["ssh", *self._common_opts, "-o", "ConnectTimeout=10",
                     f"root@{self.host}", "echo connected"],
                    capture_output=True, text=True, timeout=30,
                )
                if rc.returncode == 0:
                    print(f"[ssh] connected to {self.host}:{self.port}")
                    return
                print(f"[ssh] not ready yet: {rc.stderr.strip()}")
            except Exception as e:
                print(f"[ssh] attempt failed: {e}")
        raise RuntimeError(f"could not SSH to {self.host}:{self.port} after {len(SSH_BACKOFF_SCHEDULE)} tries")

    def run(self, cmd: str, on_line: Optional[Callable[[str], None]] = None) -> int:
        """Stream a command. Tees every line to local stdout + log_path."""
        full = ["ssh", *self._common_opts, f"root@{self.host}", cmd]
        with self.log_path.open("a") as logf:
            logf.write(f"\n\n>>> {cmd}\n")
            proc = subprocess.Popen(
                full, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1,
            )
            assert proc.stdout is not None
            try:
                for line in proc.stdout:
                    sys.stdout.write(line)
                    sys.stdout.flush()
                    logf.write(line)
                    logf.flush()
                    if on_line:
                        on_line(line)
            except KeyboardInterrupt:
                proc.terminate()
                raise
            return proc.wait()

    def rsync_up(self, local: str, remote: str, excludes: list[str]):
        excl = []
        for e in excludes:
            excl.extend(["--exclude", e])
        ssh_cmd = "ssh " + " ".join(shlex.quote(o) for o in self._common_opts)
        # NOTE: omit --info=stats1 (GNU rsync only); macOS ships openrsync.
        # NOTE: --no-owner / --no-group are required when writing to a
        # MooseFS-backed network volume mount (US-GA-2 enforces strict chown
        # rules; EU-RO-1 doesn't, but skipping owner preservation is safe
        # everywhere — files end up owned by root inside the container which
        # is exactly what we want).
        cmd = ["rsync", "-az", "--no-owner", "--no-group",
               *excl, "-e", ssh_cmd,
               local, f"root@{self.host}:{remote}"]
        print(f"[rsync] {local} -> root@{self.host}:{remote}")
        rc = subprocess.run(cmd)
        if rc.returncode != 0:
            raise RuntimeError(f"rsync failed with exit code {rc.returncode}")

    def run_in_tmux(self, name: str, cmd: str, work_dir: str,
                    on_line: Optional[Callable[[str], None]] = None) -> int:
        """Run a long-running command inside a detached tmux session and
        tail-follow its log locally over SSH.

        Why tmux: training is 14+ hrs. A transient SSH drop (which we've already
        paid $1.86 for once with an in-flight run) would normally SIGHUP the
        remote process and lose the run. With tmux the remote shell owns the
        process; if SSH dies we can manually `tmux attach -t <name>` from
        another terminal on the pod to recover.

        Mechanism on the pod:
          1. Detached tmux session runs `<cmd>; echo $? > run.exit; touch run.done`.
          2. A watcher subshell polls run.done and exits once it appears.
          3. `tail -n +1 -F run.log --pid=<watcher>` streams the log and exits
             cleanly the moment run.done shows up (--pid is GNU coreutils;
             the runpod/pytorch image on Ubuntu 22.04 has it).
          4. We `cat run.exit` to recover the command's exit code through the
             tmux session boundary, since tmux itself doesn't propagate it.

        Watchdog: the local Watchdog still ticks on every line streamed through
        ssh.run, so wall-clock and idle-stdout timeouts work normally.
        """
        log_path = f"{work_dir}/run.log"
        done_path = f"{work_dir}/run.done"
        exit_path = f"{work_dir}/run.exit"
        # Encode the inner command via base64 so embedded quotes (e.g. shlex.quote
        # on KAGGLE_KEY) survive the trip through tmux new-session's argv
        # parsing. base64 is safer than ad-hoc escaping for arbitrary content.
        import base64
        encoded = base64.b64encode(cmd.encode()).decode()
        inner = (
            f"cd {shlex.quote(work_dir)} && "
            f"echo {encoded} | base64 -d | bash; "
            f"echo $? > {shlex.quote(exit_path)}; "
            f"touch {shlex.quote(done_path)}"
        )
        remote_cmd = (
            # Clean any stale state from a previous run.
            f"rm -f {shlex.quote(log_path)} {shlex.quote(done_path)} "
            f"{shlex.quote(exit_path)} && "
            f"tmux kill-session -t {shlex.quote(name)} 2>/dev/null; "
            # Pipe the command through tee inside tmux so the log is captured
            # to disk regardless of whether anyone is tailing it.
            f"tmux new-session -d -s {shlex.quote(name)} "
            f"{shlex.quote(f'( {inner} ) 2>&1 | tee ' + log_path)} && "
            # touch the log so tail -F has something to open immediately
            # (-F retries open-on-failure, but this avoids a noisy first second).
            f"touch {shlex.quote(log_path)} && "
            # Watcher: a backgrounded subshell that exits when run.done appears.
            # tail --pid=$WATCHER follows the log and exits when watcher dies.
            f"( while [ ! -f {shlex.quote(done_path)} ]; do sleep 3; done ) & "
            f"WATCHER=$!; "
            f"tail -n +1 -F {shlex.quote(log_path)} --pid=$WATCHER 2>/dev/null; "
            f"wait $WATCHER 2>/dev/null; "
            # Pause briefly to let any final tee'd output flush, then propagate
            # the inner command's exit code as our own.
            f"sleep 1; "
            f"if [ -s {shlex.quote(exit_path)} ]; then "
            f"  exit $(cat {shlex.quote(exit_path)}); "
            f"else exit 99; fi"
        )
        return self.run(remote_cmd, on_line=on_line)

    def scp_file_down(self, remote: str, local_path: Path):
        """Pull a single remote file to a specific local path. Used for
        experiments.csv where we don't want a directory dance."""
        local_path.parent.mkdir(parents=True, exist_ok=True)
        cmd = ["scp", *self._common_opts, f"root@{self.host}:{remote}", str(local_path)]
        rc = subprocess.run(cmd)
        if rc.returncode != 0:
            # Same tar fallback approach but for one file (cat over ssh).
            with local_path.open("wb") as out:
                rc2 = subprocess.run(
                    ["ssh", *self._common_opts, f"root@{self.host}",
                     f"cat {shlex.quote(remote)}"],
                    stdout=out,
                )
            if rc2.returncode != 0:
                raise RuntimeError(
                    f"scp_file_down failed (scp={rc.returncode}, cat={rc2.returncode})")

    def scp_down(self, remote: str, local: str):
        # Make the LOCAL destination dir itself, not its parent. scp -r requires
        # the destination to exist before it'll dump remote files into it.
        Path(local).mkdir(parents=True, exist_ok=True)
        cmd = ["scp", "-r", *self._common_opts, f"root@{self.host}:{remote}", local]
        print(f"[scp] root@{self.host}:{remote} -> {local}")
        rc = subprocess.run(cmd)
        if rc.returncode != 0:
            # Fallback: pipe a tarball through SSH. More robust than scp -r
            # to OpenSSH version differences (10.x uses SFTP-mode scp by default).
            print(f"[scp] failed (rc={rc.returncode}); falling back to ssh+tar")
            remote_dir = remote.rstrip("/")
            tar_cmd = (
                ["ssh", *self._common_opts, f"root@{self.host}",
                 f"tar -C {shlex.quote(str(Path(remote_dir).parent))} "
                 f"-czf - {shlex.quote(Path(remote_dir).name)}"]
            )
            untar = ["tar", "-C", local, "-xzf", "-"]
            print(f"[tar] streaming {remote_dir} -> {local}")
            tar_proc = subprocess.Popen(tar_cmd, stdout=subprocess.PIPE)
            untar_proc = subprocess.Popen(untar, stdin=tar_proc.stdout)
            assert tar_proc.stdout is not None
            tar_proc.stdout.close()
            untar_rc = untar_proc.wait()
            tar_rc = tar_proc.wait()
            if untar_rc != 0 or tar_rc != 0:
                raise RuntimeError(
                    f"tar fallback failed: tar={tar_rc} untar={untar_rc}")
            print(f"[tar] streamed successfully")


# --------------------------------------------------------------------------- watchdog

class Watchdog:
    """Two thresholds: wall-clock and stdout-idle. Either firing -> SIGTERM self."""

    def __init__(self, wall_timeout_s: int, idle_timeout_s: int, cost_ping_s: int = 300,
                 cost_per_hour: float = 0.0):
        self.wall_timeout_s = wall_timeout_s
        self.idle_timeout_s = idle_timeout_s
        self.cost_ping_s = cost_ping_s
        self.cost_per_hour = cost_per_hour
        self._started = time.time()
        self._last_tick = time.time()
        self._last_cost_ping = time.time()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def tick(self, _line: str = ""):
        self._last_tick = time.time()

    def _loop(self):
        while not self._stop.wait(15):
            now = time.time()
            wall = now - self._started
            idle = now - self._last_tick
            if wall > self.wall_timeout_s:
                print(f"\n[watchdog] WALL-CLOCK TIMEOUT ({wall:.0f}s > {self.wall_timeout_s}s); "
                      f"sending SIGTERM to self for cleanup", file=sys.stderr)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            if idle > self.idle_timeout_s:
                print(f"\n[watchdog] IDLE TIMEOUT (no stdout for {idle:.0f}s > {self.idle_timeout_s}s); "
                      f"sending SIGTERM to self for cleanup", file=sys.stderr)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            if now - self._last_cost_ping >= self.cost_ping_s:
                est = (wall / 3600.0) * self.cost_per_hour
                print(f"[watchdog] running {wall/60:.0f}m, est ${est:.2f} so far "
                      f"({wall/self.wall_timeout_s*100:.0f}% of wall-clock budget)")
                self._last_cost_ping = now

    def __enter__(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


@contextmanager
def cleanup_guard(pod_id: str, runpod_key: str,
                  ephemeral_key: Optional[EphemeralKey] = None):
    """Triple-redundant pod termination: finally + atexit + signal handler."""
    cleaned = {"done": False}

    def _cleanup(*_):
        if cleaned["done"]:
            return
        cleaned["done"] = True
        terminate_pod(pod_id, runpod_key)
        cleanup_ephemeral_key(ephemeral_key)

    atexit.register(_cleanup)
    prev_int = signal.signal(signal.SIGINT, lambda *a: (_cleanup(), sys.exit(130)))
    prev_term = signal.signal(signal.SIGTERM, lambda *a: (_cleanup(), sys.exit(143)))
    try:
        yield
    finally:
        _cleanup()
        signal.signal(signal.SIGINT, prev_int)
        signal.signal(signal.SIGTERM, prev_term)


# --------------------------------------------------------------------------- main

_PHASE1_TARGETS: dict[str, tuple[str, str]] = {
    # mode -> (Makefile target, pretrained subdir to scp back)
    "phase1_broad":        ("pretrain-phase1-broad",        "phase1_broad"),
    "phase1_tight":        ("pretrain-phase1-tight",        "phase1_tight"),
    "phase1_kaggle_smoke": ("pretrain-phase1-kaggle-smoke", "phase1_kaggle_smoke"),
    "phase1_kaggle":       ("pretrain-phase1-kaggle",       "phase1_kaggle"),
}


def _build_run_command(mode: str, creds: Credentials, batch_size: int,
                       epochs: Optional[int] = None) -> str:
    """Compose the on-pod shell pipeline for the given mode.

    Kaggle creds are exported into the shell process only - they never touch
    disk on the pod. shlex.quote handles odd characters in the API key.

    `epochs` (optional): if set, passed to the Makefile as EPOCHS=N which
    threads through to `python -m src.train --epochs N`. Used for short
    smoke runs (e.g. --epochs 6 on the kaggle config to validate a recipe
    change for ~$3 instead of paying for the full 30-epoch run).
    """
    kaggle_env = (
        f"export KAGGLE_USERNAME={shlex.quote(creds.kaggle_user)} && "
        f"export KAGGLE_KEY={shlex.quote(creds.kaggle_key)}"
    )
    epochs_arg = f" EPOCHS={epochs}" if epochs is not None else ""
    target, _ = _PHASE1_TARGETS[mode]
    return f"{kaggle_env} && make {target} BATCH_SIZE={batch_size}{epochs_arg}"


def _scp_artifacts(ssh: "SSHSession", mode: str):
    """Pull whatever this mode produced back to the local checkout."""
    _, subdir = _PHASE1_TARGETS[mode]
    ssh.scp_down(
        f"/workspace/SignChatModel/pretrained/{subdir}/",
        "pretrained/",
    )

    # Sync the experiments.csv row train.py wrote on the pod. Use scp to /tmp
    # first, then merge into local (skip duplicate header). Best-effort:
    # log-and-skip on failure since we already have the weights.
    try:
        tmp = Path(tempfile.mkstemp(prefix="exp-pod-", suffix=".csv")[1])
        ssh.scp_file_down("/workspace/SignChatModel/experiments.csv", tmp)
        _merge_experiments_csv(tmp, Path("experiments.csv"))
        tmp.unlink(missing_ok=True)
        print("[experiments] synced row from pod")
    except Exception as e:
        print(f"[experiments] WARN failed to sync experiments.csv: {e}", file=sys.stderr)
        print(f"[experiments] metrics still in pod_session.log; can be added manually", file=sys.stderr)


def main():
    # Force line-buffered stdout so progress shows up live even when this
    # script is invoked with stdout piped to a file (e.g. backgrounded).
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--gpu", default=None,
                        help="exact GPU name to request (skip the fallback list)")
    parser.add_argument("--timeout", type=int, default=90,
                        help="wall-clock timeout in MINUTES before SIGTERM "
                             "(default 90; per-mode override applied below)")
    parser.add_argument("--idle-timeout", type=int, default=15,
                        help="no-stdout timeout in MINUTES before SIGTERM (default 15)")
    parser.add_argument("--epochs", type=int, default=None,
                        help="override cfg.train.epochs for this run (passes "
                             "through to make EPOCHS=N -> python -m src.train "
                             "--epochs N). Use to run a short smoke (e.g. "
                             "--epochs 6 ~$3 on the kaggle config) before "
                             "committing to a full run.")
    parser.add_argument("--tag", default=time.strftime("%Y%m%d-%H%M%S"),
                        help="tag appended to pod name (default: timestamp)")
    parser.add_argument("--network-volume-id", default=None,
                        help="Mount this RunPod network volume at /workspace on "
                             "the train pod. The data/cache/asl_citizen, wlasl, "
                             "wlasl_full, and kaggle_islr trees are SYM-LINKED "
                             "from /workspace/cache/<dataset>/ instead of "
                             "rsync'd from local -- much faster and removes the "
                             "95k-small-file rsync over inter-DC SSH. Set to "
                             "'412s5n8qkh' for the EU-RO-1 volume.")

    parser.add_argument(
        "--config-suffix", required=True,
        choices=("broad", "tight", "kaggle_smoke", "kaggle"),
        help="Which phase1 recipe to run: kaggle | kaggle_smoke (PopSign 250 "
             "primary) or broad | tight (cross-dataset secondary). The script "
             "rsyncs data/cache/ + pretrained/ up to the pod, then invokes "
             "`make pretrain-phase1-<suffix>`. tight ALSO rsyncs the "
             "pretrained/phase1_broad/ checkpoint up so the resume_from path "
             "resolves on the pod."
    )
    args = parser.parse_args()

    # Map --config-suffix to a mode name. Mode strings flow through to
    # phase1 cache-checks, rsync paths, and make-target dispatch.
    mode = {
        "broad":         "phase1_broad",
        "tight":         "phase1_tight",
        "kaggle_smoke":  "phase1_kaggle_smoke",
        "kaggle":        "phase1_kaggle",
    }[args.config_suffix]
    gpu_fallback = GPU_FALLBACK_PHASE1
    disk_gb = CONTAINER_DISK_GB_DEFAULT
    if args.timeout == 90:
        # broad ~4 hr; tight ~1.5 hr; kaggle_smoke ~45 min (2 epochs on
        # ~95k clips); kaggle ~2 hr (30 epochs of the smaller config).
        # Cap each with headroom.
        args.timeout = {
            "phase1_broad":         480,
            "phase1_tight":         180,
            "phase1_kaggle_smoke":  90,
            "phase1_kaggle":        180,
        }[mode]
    if args.idle_timeout == 15:
        args.idle_timeout = 60
    use_tmux_for_run = True

    LOG_FILE.unlink(missing_ok=True)
    creds = load_credentials()
    print(f"[runpod-train] mode: {mode}")
    print(f"[runpod-train] kaggle user: {creds.kaggle_user}")

    # Sanity-check the local cache exists; otherwise rsync would silently
    # push an empty dir and training would fail at data-loading time. With
    # --network-volume-id this is informational only -- the volume cache
    # provides the data.
    cache_root = Path("data/cache")
    cached = list(cache_root.glob("*/vocab.json")) if cache_root.exists() else []
    if not cached and not args.network_volume_id:
        sys.exit(
            f"ERROR: phase1 train modes require either data/cache/<dataset>/vocab.json "
            f"to exist locally OR a --network-volume-id with the cache on it; "
            f"found neither.\nRun `make pod-kaggle-islr VOLUME_ID=<id>` first to "
            "extract PopSign onto the volume."
        )
    if cached:
        sizes_gb = sum(p.stat().st_size for p in cache_root.rglob("*") if p.is_file()) / 1e9
        print(f"[runpod-train] local cache to upload: "
              f"{[p.parent.name for p in cached]} (~{sizes_gb:.2f} GB total)")
    if mode == "phase1_tight":
        # Tight mode resumes from pretrained/phase1_broad/best.weights.h5; the
        # rsync path below will pick it up too, but we sanity-check here so a
        # missing-broad-checkpoint error fails BEFORE pod provisioning.
        broad_ckpt = Path("pretrained/phase1_broad/best.weights.h5")
        if not broad_ckpt.exists():
            sys.exit(
                f"ERROR: --config-suffix tight requires {broad_ckpt} to exist "
                f"locally (will be rsync'd up). Run --config-suffix broad first."
            )
        broad_sidecar = Path("pretrained/phase1_broad/vocab.json")
        if not broad_sidecar.exists():
            print(f"[runpod-train] WARN {broad_sidecar} missing; tight will work "
                  "but the demo's strict-load will fail without a sidecar from "
                  "the broad model too. Re-train broad after the latest train.py "
                  "edit lands on the pod.")

    ephemeral = make_ephemeral_keypair()
    atexit.register(cleanup_ephemeral_key, ephemeral)

    # Network volume mount: caches that already live on the volume become
    # symlinks instead of rsync targets. The pod is pinned to the volume's
    # datacenter automatically by the SDK.
    pod_volume_id = args.network_volume_id
    pod_volume_mount = "/workspace" if pod_volume_id else "/runpod-volume"
    if pod_volume_id:
        print(f"[runpod-train] mounting network volume {pod_volume_id} "
              f"at {pod_volume_mount} (caches will be symlinked, not rsync'd)")

    try:
        pod = provision_pod(creds, args.gpu, args.tag,
                            public_key=ephemeral.public_text,
                            fallback=gpu_fallback, disk_gb=disk_gb,
                            network_volume_id=pod_volume_id,
                            volume_mount_path=pod_volume_mount)
    except Exception:
        cleanup_ephemeral_key(ephemeral)
        raise
    cost_per_hour = COST_PER_HOUR.get(pod.gpu_name, 1.0)

    with cleanup_guard(pod.id, creds.runpod_key, ephemeral_key=ephemeral):
        wait_for_running(pod, timeout_s=240)
        ssh = SSHSession(pod.ssh_host, pod.ssh_port, key_path=ephemeral.private_path)
        ssh.wait_ready()

        # The runpod/pytorch image doesn't ship rsync. Install it before we
        # rsync-up the repo. ~5-10 sec on a fresh apt cache.
        rc = ssh.run(
            "command -v rsync >/dev/null || (apt-get update -q && "
            "apt-get install -y -q rsync)",
            on_line=lambda *_: None,
        )
        if rc != 0:
            raise RuntimeError(f"failed to install rsync on pod (exit {rc})")

        # Excludes: skip caches by default. data/cache/ is handled below
        # (either via volume symlink or a separate rsync) so the repo rsync
        # stays fast.
        ssh.rsync_up(
            local="./",
            remote="/workspace/SignChatModel/",
            excludes=[".git", ".venv", "venv", "__pycache__",
                      "data/cache/", "data/raw/", "pretrained/",
                      "checkpoints/", "pod_session.log",
                      ".env", "kaggle.json"],
        )

        # Cache placement strategy:
        #   * Caches that live on the network volume (asl_citizen,
        #     wlasl_full, kaggle_islr, and the legacy MuteMotion wlasl)
        #     are SYM-LINKED into the expected repo-relative path so
        #     the YAML config's `cache_dir: - data/cache/<dataset>`
        #     "just works" without modification.
        #   * Anything else (e.g. future caches) gets rsync'd up.
        # When --network-volume-id is NOT set we fall back to always-rsync,
        # which is much slower for the kaggle_islr cache (~95k small npy
        # files over inter-DC SSH).
        VOLUME_BACKED = ("asl_citizen", "wlasl_full", "kaggle_islr", "wlasl")
        if pod_volume_id:
            print("[runpod-train] symlinking volume-backed caches into "
                  "/workspace/SignChatModel/data/cache/")
            ln_cmd = "mkdir -p /workspace/SignChatModel/data/cache && "
            for ds in VOLUME_BACKED:
                src = f"/workspace/cache/{ds}"
                dst = f"/workspace/SignChatModel/data/cache/{ds}"
                # -snf: symbolic, replace existing, force. Skip silently
                # if the volume cache doesn't exist - the loader's
                # _scan_cache will then silently skip the dir.
                ln_cmd += (f"if [ -d {src} ]; then "
                           f"rm -rf {dst} && ln -snf {src} {dst} && "
                           f"echo '[symlink] {dst} -> {src}'; "
                           f"else echo '[symlink] SKIP {src} (not present)'; fi; ")
            rc = ssh.run(ln_cmd, on_line=lambda *_: None)
            if rc != 0:
                raise RuntimeError(f"symlink setup failed (exit {rc})")
            # Rsync local caches that DON'T live on volume.
            local_only_dirs = [d for d in Path("data/cache").iterdir()
                               if d.is_dir() and d.name not in VOLUME_BACKED]
            if local_only_dirs:
                sizes = sum(f.stat().st_size for d in local_only_dirs
                            for f in d.rglob("*") if f.is_file()) / 1e9
                print(f"[runpod-train] uploading local-only caches "
                      f"{[d.name for d in local_only_dirs]} (~{sizes:.2f} GB) ...")
                for d in local_only_dirs:
                    ssh.rsync_up(
                        local=f"{d}/",
                        remote=f"/workspace/SignChatModel/{d}/",
                        excludes=["__pycache__"],
                    )
        else:
            print("[runpod-train] uploading local data/cache/ to pod "
                  "(--network-volume-id not set; full rsync path)...")
            ssh.rsync_up(
                local="data/cache/",
                remote="/workspace/SignChatModel/data/cache/",
                excludes=["__pycache__"],
            )
        if mode == "phase1_tight":
            print("[runpod-train] uploading pretrained/phase1_broad/ to pod (resume_from)...")
            ssh.rsync_up(
                local="pretrained/phase1_broad/",
                remote="/workspace/SignChatModel/pretrained/phase1_broad/",
                excludes=[],
            )

        batch_size = BATCH_BY_GPU.get(pod.gpu_name, 128)
        print(f"[runpod-train] using BATCH_SIZE={batch_size} for GPU '{pod.gpu_name}'")

        wd = Watchdog(
            wall_timeout_s=args.timeout * 60,
            idle_timeout_s=args.idle_timeout * 60,
            cost_per_hour=cost_per_hour,
        )
        with wd:
            rc = ssh.run("cd /workspace/SignChatModel && bash scripts/runpod_setup.sh",
                         on_line=wd.tick)
            if rc != 0:
                raise RuntimeError(f"setup failed with exit code {rc}")

            run_cmd = _build_run_command(mode, creds, batch_size, epochs=args.epochs)
            if use_tmux_for_run:
                rc = ssh.run_in_tmux(
                    name="signchat",
                    cmd=run_cmd,
                    work_dir="/workspace/SignChatModel",
                    on_line=wd.tick,
                )
            else:
                rc = ssh.run(
                    f"cd /workspace/SignChatModel && {run_cmd}",
                    on_line=wd.tick,
                )
            if rc != 0:
                raise RuntimeError(f"remote command failed with exit code {rc}")

        _scp_artifacts(ssh, mode)

        runtime_min = (time.time() - pod.started_at) / 60.0
        est_cost = (runtime_min / 60.0) * cost_per_hour
        print()
        print("=" * 60)
        print(f"[runpod-train] DONE  (mode={mode})")
        print(f"  pod id        : {pod.id}")
        print(f"  GPU           : {pod.gpu_name}")
        print(f"  runtime       : {runtime_min:.1f} min")
        print(f"  est cost      : ${est_cost:.2f} (at ${cost_per_hour:.2f}/hr)")
        _, subdir = _PHASE1_TARGETS[mode]
        print(f"  weights       : pretrained/{subdir}/best.weights.h5")
        print(f"  sidecar       : pretrained/{subdir}/vocab.json")
        print(f"  full log      : {LOG_FILE}")
        print("=" * 60)


if __name__ == "__main__":
    main()
