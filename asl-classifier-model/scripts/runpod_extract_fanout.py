"""Multi-CPU-pod fan-out for ASL Citizen / WLASL2000 MediaPipe extraction.

Three subcommands - usually invoked in sequence:

    prep-volume      create/reuse a network volume (default --volume-size 100
                     GB; resize via `PATCH /networkvolumes/<id>` for larger
                     datasets); pre-load the dataset either from kagglehub or
                     by ssh-tar pull from a currently-running pod
                     (--source-pod-id). Optional --pull-cache also pulls
                     in-progress .npy files from the source pod, so fan-out
                     workers resume rather than re-extract.

    extract-fanout   spin N CPU pods in parallel (default 4 x cpu5c 32 vCPU
                     5 GHz), each mounted to the shared volume, each running the
                     loader against a unique --shard-id. Aggregate watchdog
                     terminates ALL pods on idle/wall timeout. Cleanup is
                     triple-redundant (finally + atexit + signal handler).

    merge-and-fetch  spin one small CPU pod with the volume, write done.txt
                     markers via the loader's --summary-only path, rsync the
                     populated cache down to local data/cache/asl_citizen/.

Usage examples:

    # 1. Pull from a live pod, write to a fresh 100 GB volume (US-CA-2 dc):
    python -u scripts/runpod_extract_fanout.py prep-volume \\
        --source-pod-id <live_pod_id> --pull-cache

    # 2. Fan out 4 ways on the volume:
    python -u scripts/runpod_extract_fanout.py extract-fanout \\
        --volume-id <id> --num-shards 4

    # 3. Pull results back, terminate the volume's helper pod:
    python -u scripts/runpod_extract_fanout.py merge-and-fetch \\
        --volume-id <id>

CPU-pod creation goes through Runpod's REST API at https://rest.runpod.io/v1
because the runpod Python SDK (1.6.2) only knows GraphQL pod-deploy mutations
which are GPU-only. SSH+tmux primitives are reused from runpod_train.py.

Cleanup invariant: ANY exit path - normal, exception, KeyboardInterrupt,
SIGTERM, even SIGKILL hitting Python's atexit chain - terminates all pods
provisioned by this run. The shared network volume is preserved by default
(orchestrator opt-out via --delete-volume-on-success).
"""

from __future__ import annotations

import argparse
import atexit
import base64
import json
import os
import shlex
import signal
import subprocess
import sys
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

import requests

# Reuse all the heavy lifting from the GPU-pod orchestrator.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from runpod_train import (
    Credentials,
    EphemeralKey,
    SSHSession,
    cleanup_ephemeral_key,
    load_credentials,
    make_ephemeral_keypair,
    LOG_FILE,
)


REST_BASE = "https://rest.runpod.io/v1"
WORKSPACE = "/workspace"

# Image used for prep / merge / extract pods. Slim is preferable; the
# `runpod/pytorch` image is overkill but proven to work with the PUBLIC_KEY
# env-var SSH bootstrap. We pick a CPU-friendly image variant and install
# only what we need (mediapipe etc.) on first run.
CPU_POD_IMAGE = "runpod/pytorch:2.4.0-py3.11-cuda12.4.1-devel-ubuntu22.04"

# Cost per hour estimates (informational only; real billing is whatever Runpod
# charges). 5GHz Compute-Optimized 2/4/8/16/32 vCPU all bill at $0.035/vCPU/hr.
CPU_FLAVOR_PRICE_PER_VCPU_HR = 0.035

# Default fan-out worker spec. 32 vCPU 5GHz CPU pods are the per-core cost
# winner for our MediaPipe workload.
DEFAULT_CPU_FLAVOR = "cpu5c"
DEFAULT_VCPU = 32
DEFAULT_FANOUT_N = 4

# Datacenters known to have CPU + 100GB network-volume capacity at time of
# writing. List discovered empirically from the REST 500 error (the API tells
# you which DCs support volumes). The REST POST tries each in order until one
# accepts the volume creation.
PREFERRED_DCS = [
    "EU-RO-1", "EU-NL-1", "EU-CZ-1", "EU-SE-1", "EUR-IS-3", "EUR-NO-1",
    "US-IL-1", "US-KS-2", "US-TX-3", "US-WA-1", "US-GA-2", "US-NC-1",
    "US-MO-1", "US-MO-2", "US-NE-1", "US-NC-2", "CA-MTL-3", "CA-MTL-4",
    "AP-JP-1",
]


# --------------------------------------------------------------------------- REST

class RunpodREST:
    """Tiny REST wrapper for the operations the SDK (1.6.2) doesn't expose:
    CPU pod creation, network volume CRUD, and pod GET via REST (which returns
    the same fields as the GraphQL `pod` query but with a stable JSON shape)."""

    def __init__(self, api_key: str):
        self._sess = requests.Session()
        self._sess.headers.update({
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        })

    def _req(self, method: str, path: str, **kw) -> dict:
        url = f"{REST_BASE}{path}"
        rsp = self._sess.request(method, url, timeout=60, **kw)
        if rsp.status_code >= 400:
            raise RuntimeError(
                f"RunPod REST {method} {path} -> {rsp.status_code}: {rsp.text[:500]}")
        # DELETE endpoints may return empty body
        if not rsp.text:
            return {}
        try:
            return rsp.json()
        except ValueError:
            return {"raw": rsp.text}

    # --- network volumes ---

    def create_volume(self, name: str, size_gb: int,
                      data_center_id: str) -> dict:
        body = {"name": name, "size": size_gb, "dataCenterId": data_center_id}
        return self._req("POST", "/networkvolumes", json=body)

    def list_volumes(self) -> list[dict]:
        return self._req("GET", "/networkvolumes") or []

    def get_volume(self, volume_id: str) -> dict:
        return self._req("GET", f"/networkvolumes/{volume_id}")

    def delete_volume(self, volume_id: str):
        self._req("DELETE", f"/networkvolumes/{volume_id}")

    # --- pods ---

    def create_cpu_pod(self, *, name: str, vcpu: int, image: str,
                       cpu_flavor: str, network_volume_id: str,
                       env: dict, container_disk_gb: int = 50,
                       ports: list[str] = ("22/tcp",),
                       data_center_ids: Optional[list[str]] = None) -> dict:
        # `vcpuCount` sets the count; `cpuFlavorIds` is the family. Together
        # they pick a flavor + size like "cpu5c at 32 vCPU".
        body: dict[str, Any] = {
            "name": name,
            "computeType": "CPU",
            "cloudType": "SECURE",
            "cpuFlavorIds": [cpu_flavor],
            "cpuFlavorPriority": "availability",
            "vcpuCount": vcpu,
            "imageName": image,
            "containerDiskInGb": container_disk_gb,
            "ports": list(ports),
            "supportPublicIp": True,
            "env": env,
            "networkVolumeId": network_volume_id,
            "volumeMountPath": WORKSPACE,
            "interruptible": False,
        }
        if data_center_ids:
            body["dataCenterIds"] = data_center_ids
            body["dataCenterPriority"] = "availability"
        return self._req("POST", "/pods", json=body)

    def get_pod(self, pod_id: str) -> dict:
        return self._req("GET", f"/pods/{pod_id}")

    def terminate_pod(self, pod_id: str):
        try:
            self._req("DELETE", f"/pods/{pod_id}")
        except Exception as e:
            print(f"[runpod-rest] WARN failed to terminate pod {pod_id}: {e}",
                  file=sys.stderr)


# --------------------------------------------------------------------------- pod model

@dataclass
class FanPod:
    """One pod under orchestration. Tracks SSH endpoint + creation time +
    optional shard id (for fan-out cohort)."""
    id: str
    flavor: str
    vcpu: int
    ssh_host: str = ""
    ssh_port: int = 0
    started_at: float = field(default_factory=time.time)
    shard_id: Optional[int] = None
    exit_code: Optional[int] = None

    def cost_per_hour(self) -> float:
        return self.vcpu * CPU_FLAVOR_PRICE_PER_VCPU_HR


# --------------------------------------------------------------------------- volume

def get_or_create_volume(rest: RunpodREST, volume_id: Optional[str],
                         size_gb: int, dc_preferred: list[str],
                         tag: str) -> dict:
    """Return the volume dict (with 'id' and 'dataCenterId'). Creates a fresh
    volume in the first DC where creation succeeds when no id is given."""
    if volume_id:
        vol = rest.get_volume(volume_id)
        print(f"[volume] reusing {volume_id} in {vol.get('dataCenterId')} "
              f"({vol.get('size')} GB)")
        return vol
    name = f"signchat-asl-citizen-{tag}"
    last_err: Optional[Exception] = None
    for dc in dc_preferred:
        try:
            print(f"[volume] creating {size_gb} GB volume in {dc}...")
            vol = rest.create_volume(name, size_gb, dc)
            print(f"[volume] created id={vol.get('id')} in {vol.get('dataCenterId')}")
            return vol
        except Exception as e:
            print(f"[volume] {dc} failed: {e}")
            last_err = e
    raise RuntimeError(f"could not create volume in any preferred DC. Last error: {last_err}")


# --------------------------------------------------------------------------- pod ready

def _resolve_ssh_endpoint(info: dict) -> tuple[Optional[str], Optional[int]]:
    """Tolerantly extract (publicIp, ssh_port) from a REST or GraphQL pod
    info dict. Several response shapes seen in the wild:

      - REST: portMappings dict like {"22": 18694} + publicIp
      - REST (alt): portMappings list of {privatePort, publicPort, ...}
      - GraphQL runtime: runtime.ports list of {privatePort, publicPort, ip,
        isIpPublic}
    """
    public_ip = info.get("publicIp") or info.get("ip")
    ssh_port: Optional[int] = None
    pm = info.get("portMappings")
    if isinstance(pm, dict):
        v = pm.get("22") or pm.get(22) or pm.get("22/tcp")
        if v is not None:
            ssh_port = int(v)
    elif isinstance(pm, list):
        for entry in pm:
            if isinstance(entry, dict) and str(entry.get("privatePort")) == "22":
                ssh_port = int(entry.get("publicPort"))
                break
    if ssh_port is None or public_ip is None:
        runtime = info.get("runtime") or {}
        for p in (runtime.get("ports") or []):
            if p.get("privatePort") == 22 and p.get("isIpPublic"):
                public_ip = public_ip or p.get("ip")
                if ssh_port is None and p.get("publicPort") is not None:
                    ssh_port = int(p.get("publicPort"))
                break
    return public_ip, ssh_port


def wait_for_pod_ready(rest: RunpodREST, pod_id: str,
                       timeout_s: int = 300) -> tuple[str, int]:
    """Poll until the pod exposes its public SSH port. Returns (host, port)."""
    print(f"[runpod-rest] waiting for {pod_id} to come up (max {timeout_s}s)...")
    deadline = time.time() + timeout_s
    last_status = None
    while time.time() < deadline:
        info = rest.get_pod(pod_id)
        public_ip, ssh_port = _resolve_ssh_endpoint(info)
        last_status = info.get("desiredStatus") or info.get("status")
        if public_ip and ssh_port and last_status == "RUNNING":
            print(f"[runpod-rest] pod ready: ssh root@{public_ip} -p {ssh_port}")
            return public_ip, ssh_port
        time.sleep(5)
    raise TimeoutError(f"pod {pod_id} did not expose SSH within {timeout_s}s "
                       f"(last status={last_status!r})")


# --------------------------------------------------------------------------- key injection

def _resolve_source_pod_key(explicit: Optional[str] = None,
                             exclude: Optional[Path] = None) -> Path:
    """Return the path to the SSH private key the running runpod_train.py is
    using. Either user-provided via --source-key, or auto-detected as the
    newest signchat-pod-* dir under tempfile.gettempdir() that is NOT
    `exclude` (used to skip the orchestrator's own freshly-minted ephemeral
    keypair, which is otherwise the newest signchat-pod-* dir on disk)."""
    if explicit:
        p = Path(explicit)
        if not p.exists():
            sys.exit(f"ERROR: --source-key {p} does not exist")
        return p
    tmp = Path(tempfile.gettempdir())
    candidates = sorted(
        [p for p in tmp.glob("signchat-pod-*") if p.is_dir()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    for d in candidates:
        if exclude is not None and d.resolve() == Path(exclude).resolve():
            continue
        k = d / "id_ed25519"
        if k.exists():
            print(f"[ssh-injection] auto-detected source pod key at {k}")
            return k
    sys.exit("ERROR: no source signchat-pod-*/id_ed25519 in temp dir "
             "(other than the orchestrator's own ephemeral key). Pass --source-key.")


def inject_pubkey_into_source_pod(rest: RunpodREST, source_pod_id: str,
                                   pubkey_text: str, source_key: Path):
    """Append `pubkey_text` to the source pod's ~/.ssh/authorized_keys via a
    one-shot ssh from M4. Uses the source pod's existing authorized key (the
    one the running script is using) so we don't disturb that script."""
    info = rest.get_pod(source_pod_id)
    public_ip, ssh_port = _resolve_ssh_endpoint(info)
    if not (public_ip and ssh_port):
        raise RuntimeError(f"could not resolve SSH endpoint for source pod {source_pod_id}")
    print(f"[ssh-injection] adding pubkey to source pod {source_pod_id} "
          f"({public_ip}:{ssh_port})")
    cmd = [
        "ssh", "-i", str(source_key),
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "LogLevel=ERROR",
        "-o", "ConnectTimeout=15",
        "-p", str(ssh_port), f"root@{public_ip}",
        f"mkdir -p ~/.ssh && chmod 700 ~/.ssh && "
        f"echo {shlex.quote(pubkey_text)} >> ~/.ssh/authorized_keys && "
        f"chmod 600 ~/.ssh/authorized_keys",
    ]
    rc = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if rc.returncode != 0:
        raise RuntimeError(
            f"ssh-injection failed (exit {rc.returncode}): {rc.stderr.strip()}")
    print("[ssh-injection] pubkey added")
    return public_ip, ssh_port


# --------------------------------------------------------------------------- cleanup guard

@contextmanager
def cleanup_pods(rest: RunpodREST, pods: list[FanPod],
                 ephemeral: Optional[EphemeralKey] = None,
                 keep_volume_id: Optional[str] = None,
                 delete_volume: bool = False):
    """Triple-redundant termination of ALL pods in the cohort. The volume is
    preserved unless `delete_volume=True`."""
    cleaned = {"done": False}

    def _cleanup(*_):
        if cleaned["done"]:
            return
        cleaned["done"] = True
        for p in pods:
            if p.id:
                rest.terminate_pod(p.id)
                print(f"[runpod-rest] terminated pod {p.id}")
        cleanup_ephemeral_key(ephemeral)
        if delete_volume and keep_volume_id:
            try:
                rest.delete_volume(keep_volume_id)
                print(f"[volume] deleted {keep_volume_id}")
            except Exception as e:
                print(f"[volume] WARN failed to delete {keep_volume_id}: {e}",
                      file=sys.stderr)

    atexit.register(_cleanup)
    prev_int = signal.signal(signal.SIGINT, lambda *a: (_cleanup(), sys.exit(130)))
    prev_term = signal.signal(signal.SIGTERM, lambda *a: (_cleanup(), sys.exit(143)))
    try:
        yield
    finally:
        _cleanup()
        signal.signal(signal.SIGINT, prev_int)
        signal.signal(signal.SIGTERM, prev_term)


# --------------------------------------------------------------------------- aggregate watchdog

class AggregateWatchdog:
    """One shared idle clock + wall-clock cap across N pods. Any pod's stdout
    line resets the idle clock. SIGTERMs the script process on either limit."""

    def __init__(self, wall_timeout_s: int, idle_timeout_s: int,
                 cost_per_hour_fn: Callable[[], float],
                 ping_s: int = 300):
        self.wall_timeout_s = wall_timeout_s
        self.idle_timeout_s = idle_timeout_s
        self.cost_per_hour_fn = cost_per_hour_fn
        self.ping_s = ping_s
        self._started = time.time()
        self._last_tick = time.time()
        self._last_ping = time.time()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def tick(self, _line: str = ""):
        with self._lock:
            self._last_tick = time.time()

    def _loop(self):
        while not self._stop.wait(15):
            now = time.time()
            with self._lock:
                wall = now - self._started
                idle = now - self._last_tick
            if wall > self.wall_timeout_s:
                print(f"\n[watchdog] WALL-CLOCK TIMEOUT ({wall:.0f}s > "
                      f"{self.wall_timeout_s}s); SIGTERM self for cleanup",
                      file=sys.stderr)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            if idle > self.idle_timeout_s:
                print(f"\n[watchdog] IDLE TIMEOUT ({idle:.0f}s > "
                      f"{self.idle_timeout_s}s no stdout); SIGTERM self",
                      file=sys.stderr)
                os.kill(os.getpid(), signal.SIGTERM)
                return
            if now - self._last_ping >= self.ping_s:
                rate = self.cost_per_hour_fn()
                est = (wall / 3600.0) * rate
                print(f"[watchdog] running {wall/60:.0f}m, est ${est:.2f} "
                      f"so far across active pods @ ${rate:.2f}/hr "
                      f"({wall/self.wall_timeout_s*100:.0f}% of wall budget)")
                self._last_ping = now

    def __enter__(self):
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)


# --------------------------------------------------------------------------- prep-volume

PREP_CONTAINER_DISK_GB = 50

def cmd_prep_volume(args, creds: Credentials, rest: RunpodREST):
    """Provision one small CPU pod with the volume; pre-load the dataset onto
    /workspace/datasets/ASL_Citizen, optionally pulling from a live source pod
    instead of redownloading from Kaggle."""
    vol = get_or_create_volume(
        rest, args.volume_id, args.volume_size, PREFERRED_DCS, args.tag)
    volume_id = vol["id"]
    dc_id = vol.get("dataCenterId")

    ephemeral = make_ephemeral_keypair()
    atexit.register(cleanup_ephemeral_key, ephemeral)

    pods: list[FanPod] = []
    with cleanup_pods(rest, pods, ephemeral=ephemeral):
        # Inject prep pod's pubkey into source pod BEFORE provisioning so we
        # fail fast if the source pod is unreachable. Excludes the orchestrator's
        # own freshly-minted ephemeral key from auto-detection (it's the newest
        # signchat-pod-* dir on disk and would otherwise win).
        if args.source_pod_id:
            source_key = _resolve_source_pod_key(args.source_key,
                                                 exclude=ephemeral.temp_dir)
            src_host, src_port = inject_pubkey_into_source_pod(
                rest, args.source_pod_id, ephemeral.public_text, source_key)
        else:
            src_host = src_port = None

        # Provision a small CPU pod (4 vCPU is enough for ssh+tar bandwidth).
        env = {"PUBLIC_KEY": ephemeral.public_text}
        if not args.source_pod_id:
            # Need Kaggle creds for kagglehub-download path
            env["KAGGLE_USERNAME"] = creds.kaggle_user
            env["KAGGLE_KEY"] = creds.kaggle_key

        try:
            pod_resp = rest.create_cpu_pod(
                name=f"signchat-prep-{args.tag}",
                vcpu=4, image=CPU_POD_IMAGE,
                cpu_flavor=DEFAULT_CPU_FLAVOR,
                network_volume_id=volume_id,
                env=env,
                container_disk_gb=PREP_CONTAINER_DISK_GB,
                data_center_ids=[dc_id] if dc_id else None,
            )
        except Exception as e:
            sys.exit(f"ERROR: failed to create prep pod: {e}")
        prep = FanPod(id=pod_resp["id"], flavor=DEFAULT_CPU_FLAVOR, vcpu=4)
        pods.append(prep)
        print(f"[prep] pod id={prep.id}")

        prep.ssh_host, prep.ssh_port = wait_for_pod_ready(rest, prep.id, timeout_s=480)
        ssh = SSHSession(prep.ssh_host, prep.ssh_port,
                         key_path=ephemeral.private_path)
        ssh.wait_ready()

        # Make sure tar/rsync are available
        ssh.run(
            "command -v rsync >/dev/null || (apt-get update -q && "
            "apt-get install -y -q rsync tar)",
            on_line=lambda *_: None,
        )

        # Where the volume mounts
        ssh.run("mkdir -p /workspace/datasets /workspace/cache",
                on_line=lambda *_: None)

        # Optional: clean .kagglehub cache before downloading. Guarded on
        # ASL_Citizen videos already being extracted out, so we don't wipe
        # raw ZIP material an in-flight extract still needs. Used when
        # back-to-back kagglehub downloads would overflow the volume
        # (asl-citizen + asl-signs + wlasl-processed don't all fit in
        # .kagglehub at once).
        if getattr(args, "clean_kagglehub", False):
            print("[prep] --clean-kagglehub requested; checking guard...")
            rc = ssh.run(
                "set -e; "
                "if [ -d /workspace/datasets/ASL_Citizen/videos ] && "
                "[ \"$(find /workspace/datasets/ASL_Citizen/videos -maxdepth 1 "
                "-name '*.mp4' | head -1)\" != \"\" ]; then "
                "  echo '[prep] guard OK: ASL_Citizen videos already extracted; "
                "wiping /workspace/.kagglehub'; "
                "  rm -rf /workspace/.kagglehub; "
                "  df -h /workspace; "
                "else "
                "  echo '[prep] guard FAILED: /workspace/datasets/ASL_Citizen/videos "
                "is missing or empty; refusing to clean .kagglehub'; "
                "  exit 44; "
                "fi",
                on_line=lambda line: print(line, end=""),
            )
            if rc != 0:
                raise RuntimeError(
                    "--clean-kagglehub guard failed; will not wipe the cache "
                    "with no extracted ASL Citizen videos on disk."
                )

        if args.source_pod_id:
            # ssh-tar pull videos from source pod -> volume
            print("[prep] pulling videos from source pod via ssh+tar...")
            # Write the source pod's PRIVATE key onto the prep pod so we can ssh
            # FROM prep TO source. The source pod's authorized_keys now includes
            # our ephemeral pubkey, so we use the ephemeral PRIVATE key for that.
            ssh.run(
                "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
                on_line=lambda *_: None,
            )
            # Copy ephemeral private key to prep pod via stdin -> tee
            with ephemeral.private_path.open() as kf:
                key_b64 = base64.b64encode(kf.read().encode()).decode()
            install_key = (
                f"echo {shlex.quote(key_b64)} | base64 -d > ~/.ssh/source_pod_key && "
                f"chmod 600 ~/.ssh/source_pod_key"
            )
            ssh.run(install_key, on_line=lambda *_: None)

            # Find the source-pod path to ASL_Citizen (kagglehub places it
            # under .../datasets/abd0kamel/asl-citizen/versions/1/ASL_Citizen)
            ssh_to_source = (
                f"ssh -i ~/.ssh/source_pod_key "
                f"-o IdentitiesOnly=yes -o StrictHostKeyChecking=no "
                f"-o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "
                f"-p {src_port} root@{src_host}"
            )
            # Discover the actual ASL_Citizen path on source
            rc = ssh.run(
                f"set -o pipefail; "
                f"src_root=$({ssh_to_source} 'find /root/.cache/kagglehub "
                f"-maxdepth 6 -name ASL_Citizen -type d | head -1'); "
                f"echo \"[prep] source ASL_Citizen path: $src_root\"; "
                f"test -n \"$src_root\" || exit 22; "
                f"{ssh_to_source} \"tar -C \\\"$(dirname $src_root)\\\" "
                f"-cf - \\\"$(basename $src_root)\\\"\" "
                f"| tar -xf - -C /workspace/datasets/",
                on_line=lambda *_: None,
            )
            if rc != 0:
                raise RuntimeError(f"ssh+tar pull of videos failed (exit {rc})")
            print("[prep] videos pulled")

            if args.pull_cache:
                print("[prep] pulling in-progress .npy cache from source pod...")
                rc = ssh.run(
                    f"set -o pipefail; "
                    # SignChatModel/data/cache/asl_citizen lives at
                    # /workspace/SignChatModel/data/cache/asl_citizen on source
                    f"{ssh_to_source} 'test -d "
                    f"/workspace/SignChatModel/data/cache/asl_citizen' "
                    f"|| {{ echo \"no cache on source pod\"; exit 33; }}; "
                    f"{ssh_to_source} 'tar -C /workspace/SignChatModel/data/cache "
                    f"-cf - asl_citizen' | tar -xf - -C /workspace/cache/",
                    on_line=lambda *_: None,
                )
                if rc != 0:
                    raise RuntimeError(
                        f"ssh+tar pull of cache failed (exit {rc}); "
                        "the videos are already on the volume; "
                        "you can re-run with --pull-cache=0 to skip the cache pull")
                print("[prep] cache pulled")
            # Wipe the source-pod key from the prep pod (it's about to be
            # terminated anyway, but defense in depth).
            ssh.run("rm -f ~/.ssh/source_pod_key", on_line=lambda *_: None)
        else:
            # kagglehub fallback path. Point KAGGLEHUB_CACHE at the network
            # volume so the (42.8 GB ZIP + 42.8 GB extracted) lands on the
            # volume rather than the small (~50 GB) container disk -- the
            # latter would OSError "no space left on device".
            #
            # Wrap in tmux: the download+extract takes 20-50 min depending on
            # the volume's MooseFS write throughput. Without tmux, a local
            # network blip on the orchestrator side would drop the SSH
            # session and kill the foreground command on the pod. With tmux,
            # the session survives on the pod; ssh.run_in_tmux reconnects
            # and tails the existing session if the orchestrator restarts.
            print("[prep] installing tmux on prep pod...")
            ssh.run(
                "command -v tmux >/dev/null || "
                "(apt-get install -y -q tmux)",
                on_line=lambda *_: None,
            )
            ds = getattr(args, "dataset", "asl_citizen")
            if ds == "asl_citizen":
                kaggle_slug = "abd0kamel/asl-citizen"
                rglob_target = "ASL_Citizen"
                dst_path = "/workspace/datasets/ASL_Citizen"
                size_label = "~42.8 GB"
            elif ds == "wlasl_raw":
                # risangbaskoro/wlasl-processed unpacks to a top-level dir
                # named "wlasl" containing WLASL_v0.3.json and videos/.
                kaggle_slug = "risangbaskoro/wlasl-processed"
                rglob_target = "WLASL_v0.3.json"
                dst_path = "/workspace/datasets/wlasl"
                size_label = "~10 GB"
            else:
                raise RuntimeError(f"unknown --dataset for prep-volume: {ds}")
            print(f"[prep] downloading {kaggle_slug} ({size_label}) into volume "
                  f"-> {dst_path}, in tmux...")
            # The python heredoc looks for ``rglob_target`` to anchor the source
            # directory regardless of how kagglehub nests its extraction (some
            # versions add /versions/N/, some don't). For wlasl_raw the rglob
            # target is a FILE (WLASL_v0.3.json), so we move its parent dir.
            rc = ssh.run_in_tmux(
                name="signchat-prep",
                cmd=(
                    "mkdir -p /workspace/.kagglehub && "
                    "export KAGGLEHUB_CACHE=/workspace/.kagglehub && "
                    "pip install -q kagglehub==0.3.6 && "
                    "python -c \"import os, kagglehub, shutil; "
                    "from pathlib import Path; "
                    "os.environ['KAGGLEHUB_CACHE']='/workspace/.kagglehub'; "
                    f"p = Path(kagglehub.dataset_download('{kaggle_slug}')); "
                    f"hits = list(p.rglob('{rglob_target}')); "
                    "src = hits[0].parent if hits and hits[0].is_file() "
                    "else (hits[0] if hits else None); "
                    f"dst = Path('{dst_path}'); "
                    "dst.parent.mkdir(parents=True, exist_ok=True); "
                    "shutil.move(str(src), str(dst)) "
                    "if (src is not None and not dst.exists()) else None; "
                    "print(f'{dst.name} at {dst}')\""
                ),
                work_dir="/workspace",
                on_line=lambda *_: None,
            )
            if rc != 0:
                raise RuntimeError(f"kagglehub download failed (exit {rc})")

        # Verify (per-dataset paths)
        ds = getattr(args, "dataset", "asl_citizen")
        print("[prep] verifying file counts on volume...")
        if ds == "asl_citizen":
            ssh.run(
                "echo \"videos: $(find /workspace/datasets/ASL_Citizen/videos "
                "-name '*.mp4' 2>/dev/null | wc -l)\"; "
                "echo \"splits: $(ls /workspace/datasets/ASL_Citizen/splits/ 2>/dev/null)\"; "
                "echo \"cache npy: $(find /workspace/cache/asl_citizen "
                "-name '*.npy' 2>/dev/null | wc -l)\"",
                on_line=lambda *_: None,
            )
        elif ds == "wlasl_raw":
            ssh.run(
                "echo \"videos: $(find /workspace/datasets/wlasl/videos "
                "-name '*.mp4' 2>/dev/null | wc -l)\"; "
                "echo \"manifest: $(ls /workspace/datasets/wlasl/WLASL_v0.3.json 2>/dev/null)\"; "
                "echo \"cache npy: $(find /workspace/cache/wlasl_full "
                "-name '*.npy' 2>/dev/null | wc -l)\"",
                on_line=lambda *_: None,
            )

        # Write a manifest stamp into the volume root so future runs can verify
        # it's the expected dataset. Append-mode JSONL so back-to-back preps
        # (asl_citizen → wlasl_raw) both leave a trail.
        manifest_entry = {
            "tag": args.tag,
            "dataset": ds,
            "pulled_from": args.source_pod_id or "kaggle",
            "pull_cache": bool(args.pull_cache),
            "clean_kagglehub": bool(getattr(args, "clean_kagglehub", False)),
        }
        ssh.run(
            f"echo {shlex.quote(json.dumps(manifest_entry))} "
            f">> /workspace/manifest.jsonl",
            on_line=lambda *_: None,
        )

    runtime_min = (time.time() - prep.started_at) / 60.0
    cost = (runtime_min / 60.0) * prep.cost_per_hour()
    print()
    print("=" * 60)
    print(f"[prep] DONE")
    print(f"  volume_id     : {volume_id}")
    print(f"  data_center   : {dc_id}")
    print(f"  pod runtime   : {runtime_min:.1f} min")
    print(f"  est cost      : ${cost:.2f}")
    print(f"  next step     : VOLUME_ID={volume_id} make pod-extract-fanout N=4")
    print("=" * 60)


# --------------------------------------------------------------------------- extract-fanout

def cmd_extract_fanout(args, creds: Credentials, rest: RunpodREST):
    """Spin N CPU pods sharing the volume; each runs the loader on its shard."""
    if not args.volume_id:
        sys.exit("ERROR: --volume-id is required for extract-fanout")
    vol = rest.get_volume(args.volume_id)
    dc_id = vol.get("dataCenterId")
    print(f"[fanout] using volume {args.volume_id} in {dc_id}")

    ephemeral = make_ephemeral_keypair()
    atexit.register(cleanup_ephemeral_key, ephemeral)

    pods: list[FanPod] = []

    with cleanup_pods(rest, pods, ephemeral=ephemeral):
        # Provision N pods in parallel. RunPod returns 500 "Something went
        # wrong" intermittently under load, especially when several create
        # requests land at the same time. Retry transient 500s with jittered
        # exponential backoff before giving up. Burned $0 on this call but
        # the orphan pods were costing pennies/min until manual cleanup.
        env = {"PUBLIC_KEY": ephemeral.public_text}
        PROVISION_RETRY_BACKOFFS = [5, 15, 30]    # seconds; 4 attempts total

        def _provision(i: int) -> FanPod:
            last_err: Exception | None = None
            for attempt, backoff in enumerate([0] + PROVISION_RETRY_BACKOFFS):
                if backoff:
                    time.sleep(backoff)
                try:
                    resp = rest.create_cpu_pod(
                        name=f"signchat-extract-{args.tag}-s{i}",
                        vcpu=args.vcpu, image=CPU_POD_IMAGE,
                        cpu_flavor=args.cpu_flavor,
                        network_volume_id=args.volume_id,
                        env=env,
                        container_disk_gb=args.container_disk_gb,
                        data_center_ids=[dc_id] if dc_id else None,
                    )
                    p = FanPod(id=resp["id"], flavor=args.cpu_flavor,
                               vcpu=args.vcpu, shard_id=i)
                    if attempt:
                        print(f"[fanout] shard {i}: provisioned on attempt "
                              f"{attempt + 1}: pod id={p.id}", file=sys.stderr)
                    else:
                        print(f"[fanout] shard {i}: pod id={p.id}")
                    return p
                except Exception as e:
                    last_err = e
                    is_500 = "500" in str(e)
                    if attempt < len(PROVISION_RETRY_BACKOFFS) and is_500:
                        print(f"[fanout] shard {i} provision attempt "
                              f"{attempt + 1} got 500; retrying in "
                              f"{PROVISION_RETRY_BACKOFFS[attempt]}s",
                              file=sys.stderr)
                        continue
                    print(f"[fanout] shard {i} provision FAILED after "
                          f"{attempt + 1} attempts: {e}", file=sys.stderr)
                    raise
            raise RuntimeError(f"unreachable: last_err={last_err}")

        # Provision SERIALLY, not in parallel. Empirical: parallel requests
        # for multiple cpu5c-32 pods to EU-RO-1 frequently leave the 2nd pod
        # without a public SSH port even though it reaches RUNNING. Suspect
        # the RunPod scheduler can only allocate one cpu5c-32 at a time in a
        # constrained DC and the 2nd allocation gets a partial state. Serial
        # provisioning with a brief settle gap between pods sidesteps this
        # without losing the parallel EXTRACTION downstream.
        #
        # CRITICAL: append every successfully provisioned pod to `pods` BEFORE
        # raising on any failure, so partial-provision survivors are torn
        # down by cleanup_pods. Prior bug here was an as_completed loop that
        # short-circuited on the first exception, leaving siblings as orphans.
        PROVISION_SETTLE_S = 30
        failed: list[tuple[int, BaseException]] = []
        for i in range(args.num_shards):
            try:
                pods.append(_provision(i))
            except BaseException as e:
                failed.append((i, e))
                continue
            if i + 1 < args.num_shards:
                print(f"[fanout] settling {PROVISION_SETTLE_S}s before next "
                      "shard (RunPod scheduler back-off)", file=sys.stderr)
                time.sleep(PROVISION_SETTLE_S)
        if failed:
            first_id, first_err = failed[0]
            raise RuntimeError(
                f"{len(failed)}/{args.num_shards} shards failed to "
                f"provision (e.g. shard {first_id}: {first_err}); "
                f"{len(pods)} successful pods will be terminated by cleanup"
            ) from first_err

        # Wait for all to be SSH-ready in parallel
        def _wait(p: FanPod):
            host, port = wait_for_pod_ready(rest, p.id, timeout_s=480)
            p.ssh_host = host
            p.ssh_port = port
            return p

        with ThreadPoolExecutor(max_workers=len(pods)) as ex:
            list(ex.map(_wait, pods))

        # Aggregate watchdog: any pod's line resets the shared idle clock
        wd = AggregateWatchdog(
            wall_timeout_s=args.timeout * 60,
            idle_timeout_s=args.idle_timeout * 60,
            cost_per_hour_fn=lambda: sum(p.cost_per_hour() for p in pods
                                          if p.exit_code is None),
        )

        with wd:
            # Per-pod runner: install rsync, drop our repo on the pod, install
            # python deps the loader needs, then tmux-run the shard.
            def _run_one(p: FanPod):
                ssh = SSHSession(p.ssh_host, p.ssh_port,
                                 key_path=ephemeral.private_path,
                                 log_path=Path(f"pod_extract_fanout_s{p.shard_id}.log"))
                # Install rsync + ffmpeg + opencv deps + tmux. tmux must be
                # present BEFORE ssh.run_in_tmux below (the runpod/pytorch
                # 2.4.0 base image stopped shipping tmux at some point;
                # earlier successful runs of this fan-out happened to land
                # on a host with cached layers).
                ssh.run(
                    "command -v rsync >/dev/null && command -v tmux >/dev/null "
                    "|| (apt-get update -q && "
                    "    apt-get install -y -q rsync tmux libgl1 libglib2.0-0 "
                    "libsm6 libxext6 libxrender1 ffmpeg)",
                    on_line=wd.tick,
                )
                # Push the repo (small; <5 MB excluding caches)
                ssh.rsync_up(
                    local="./",
                    remote="/workspace/SignChatModel/",
                    excludes=[".git", ".venv", "venv", "__pycache__",
                              "data/cache/", "data/raw/", "pretrained/",
                              "checkpoints/", "pod_*.log",
                              ".env", "kaggle.json"],
                )
                # Install Python deps. We don't need TF here, just MediaPipe +
                # numpy + opencv-python + tqdm + kagglehub.
                #
                # mediapipe MUST be 0.10.9: matches requirements.txt.
                # 0.10.14 + 0.10.18 BOTH have a PoseLandmarkCpu
                # Calculator::Open() crash on the runpod/pytorch:2.4.0 image.
                # 0.10.9 ships a cp311 wheel that installs cleanly on the
                # image's default python 3.11.
                pip_pkgs = ("mediapipe==0.10.9 opencv-python==4.10.0.84 "
                            "numpy==1.26.4 tqdm==4.66.1")
                ssh.run(
                    "pip install -q --upgrade pip && "
                    f"pip install -q {pip_pkgs}",
                    on_line=wd.tick,
                )
                # Sanity: actually construct a Holistic graph BEFORE the
                # loader spins up 16 workers all hitting the same crash.
                # If init fails, print the full traceback (not the loader's
                # 80-char truncation) and fail fast.
                rc_init = ssh.run(
                    "python - <<'PY'\n"
                    "import sys\n"
                    "import mediapipe as mp\n"
                    "print('mediapipe:', mp.__version__)\n"
                    "try:\n"
                    "    h = mp.solutions.holistic.Holistic(\n"
                    "        static_image_mode=False, model_complexity=2,\n"
                    "        smooth_landmarks=True, refine_face_landmarks=False,\n"
                    "        min_detection_confidence=0.5, min_tracking_confidence=0.5)\n"
                    "    h.close()\n"
                    "    print('holistic init OK')\n"
                    "except Exception as e:\n"
                    "    import traceback; traceback.print_exc()\n"
                    "    sys.exit(42)\n"
                    "PY",
                    on_line=wd.tick,
                )
                if rc_init != 0:
                    raise RuntimeError(
                        f"shard {p.shard_id} mediapipe Holistic init failed "
                        f"(exit {rc_init}); see traceback above. The loader "
                        "would have hit this on every clip."
                    )
                # Loader: read vocab from /workspace/cache/<dataset>/vocab.json
                # (written by the FIRST shard's main(); subsequent shards see it
                # via --vocab-from). Race: if all shards start simultaneously,
                # the first one through writes the file. Mitigation: alias
                # resolution against the dataset's full vocab is deterministic
                # so all shards converge on the same vocab list independently.
                if args.dataset == "asl_citizen":
                    vocab_arg = (
                        f"--gloss-list /workspace/SignChatModel/{args.gloss_list}"
                        if args.gloss_list else f"--top-k {args.top_k}"
                    )
                    pp_arg = "--per-participant" if args.per_participant else ""
                    run_cmd = (
                        "cd /workspace/SignChatModel && "
                        "python -u -m src.data.asl_citizen_loader "
                        "--source-dir /workspace/datasets/ASL_Citizen "
                        "--out-dir /workspace/cache/asl_citizen "
                        f"{vocab_arg} {pp_arg} "
                        f"--num-shards {args.num_shards} --shard-id {p.shard_id} "
                        f"--workers {args.workers} --skip-summary"
                    )
                elif args.dataset == "wlasl_raw":
                    # WLASL2000 raw mp4s already on volume at
                    # /workspace/datasets/wlasl. Loader is per-participant by
                    # default (matches ASL Citizen v2 layout).
                    vocab_arg = (
                        f"--gloss-list /workspace/SignChatModel/{args.gloss_list}"
                        if args.gloss_list else f"--top-k {args.top_k}"
                    )
                    run_cmd = (
                        "cd /workspace/SignChatModel && "
                        "python -u -m src.data.wlasl_raw_loader "
                        "--source-dir /workspace/datasets/wlasl "
                        "--out-dir /workspace/cache/wlasl_full "
                        f"{vocab_arg} "
                        f"--num-shards {args.num_shards} --shard-id {p.shard_id} "
                        f"--workers {args.workers} --skip-summary"
                    )
                else:
                    raise RuntimeError(f"unknown dataset: {args.dataset}")
                rc = ssh.run_in_tmux(
                    name=f"extract-s{p.shard_id}",
                    cmd=run_cmd,
                    work_dir="/workspace/SignChatModel",
                    on_line=wd.tick,
                )
                p.exit_code = rc
                print(f"[fanout] shard {p.shard_id} exit={rc}")

            errors: list[Exception] = []
            def _run_one_safe(p: FanPod):
                try:
                    _run_one(p)
                except Exception as e:
                    errors.append(e)
                    p.exit_code = -1
                    print(f"[fanout] shard {p.shard_id} ERRORED: {e}", file=sys.stderr)

            with ThreadPoolExecutor(max_workers=len(pods)) as ex:
                list(ex.map(_run_one_safe, pods))

        # Summarize
        print()
        print("=" * 60)
        print(f"[fanout] DONE")
        for p in pods:
            runtime = (time.time() - p.started_at) / 60.0
            cost = (runtime / 60.0) * p.cost_per_hour()
            print(f"  shard {p.shard_id}: pod={p.id} runtime={runtime:.1f}m "
                  f"cost=${cost:.2f} exit={p.exit_code}")
        total_cost = sum(((time.time() - p.started_at) / 3600.0) * p.cost_per_hour()
                         for p in pods)
        print(f"  total cost     : ${total_cost:.2f}")
        print(f"  next step      : VOLUME_ID={args.volume_id} make pod-extract-merge")
        print("=" * 60)
        if any(p.exit_code != 0 for p in pods):
            sys.exit("ERROR: at least one shard had a non-zero exit; "
                     "merge step refuses to proceed")


# --------------------------------------------------------------------------- merge-and-fetch

def cmd_merge_and_fetch(args, creds: Credentials, rest: RunpodREST):
    """One small CPU pod: write done.txt markers + rsync the cache down."""
    if not args.volume_id:
        sys.exit("ERROR: --volume-id is required for merge-and-fetch")
    vol = rest.get_volume(args.volume_id)
    dc_id = vol.get("dataCenterId")
    print(f"[merge] using volume {args.volume_id} in {dc_id}")

    ephemeral = make_ephemeral_keypair()
    atexit.register(cleanup_ephemeral_key, ephemeral)
    pods: list[FanPod] = []

    with cleanup_pods(rest, pods, ephemeral=ephemeral):
        env = {"PUBLIC_KEY": ephemeral.public_text}
        try:
            resp = rest.create_cpu_pod(
                name=f"signchat-merge-{args.tag}",
                vcpu=4, image=CPU_POD_IMAGE,
                cpu_flavor=DEFAULT_CPU_FLAVOR,
                network_volume_id=args.volume_id,
                env=env,
                container_disk_gb=PREP_CONTAINER_DISK_GB,
                data_center_ids=[dc_id] if dc_id else None,
            )
        except Exception as e:
            sys.exit(f"ERROR: failed to create merge pod: {e}")
        merge = FanPod(id=resp["id"], flavor=DEFAULT_CPU_FLAVOR, vcpu=4)
        pods.append(merge)
        print(f"[merge] pod id={merge.id}")

        merge.ssh_host, merge.ssh_port = wait_for_pod_ready(rest, merge.id, timeout_s=480)
        ssh = SSHSession(merge.ssh_host, merge.ssh_port,
                         key_path=ephemeral.private_path)
        ssh.wait_ready()

        # Install minimal deps and push the repo (we need the loader for --summary-only)
        ssh.run(
            "command -v rsync >/dev/null || (apt-get update -q && "
            "apt-get install -y -q rsync)",
            on_line=lambda *_: None,
        )
        ssh.rsync_up(
            local="./",
            remote="/workspace/SignChatModel/",
            excludes=[".git", ".venv", "venv", "__pycache__",
                      "data/cache/", "data/raw/", "pretrained/",
                      "checkpoints/", "pod_*.log",
                      ".env", "kaggle.json"],
        )
        ssh.run(
            "pip install -q --upgrade pip && pip install -q numpy==1.26.4 tqdm==4.66.1",
            on_line=lambda *_: None,
        )
        ds = args.dataset
        # Per-dataset: loader module + on-volume cache subdir + local target.
        # wlasl_raw uses /workspace/cache/wlasl_full (matches local
        # data/cache/wlasl_full convention; "wlasl" alone is the legacy
        # MuteMotion cache root we don't want to clobber).
        if ds == "asl_citizen":
            loader_module = "src.data.asl_citizen_loader"
            cache_subdir = "asl_citizen"
        elif ds == "wlasl_raw":
            loader_module = "src.data.wlasl_raw_loader"
            cache_subdir = "wlasl_full"
        else:
            raise RuntimeError(f"unknown dataset: {ds}")
        # Verify count then write done.txt markers
        ssh.run(
            f"find /workspace/cache/{cache_subdir} -name '*.npy' | wc -l",
            on_line=lambda *_: None,
        )
        rc = ssh.run(
            "cd /workspace/SignChatModel && "
            f"python -u -m {loader_module} --summary-only "
            f"--out-dir /workspace/cache/{cache_subdir}",
            on_line=lambda *_: None,
        )
        if rc != 0:
            raise RuntimeError(f"--summary-only failed (exit {rc})")

        # Pull cache down to local data/cache/<cache_subdir>
        Path("data/cache").mkdir(parents=True, exist_ok=True)
        ssh.scp_down(
            f"/workspace/cache/{cache_subdir}/",
            "data/cache/",
        )

    runtime = (time.time() - merge.started_at) / 60.0
    cost = (runtime / 60.0) * merge.cost_per_hour()
    print()
    print("=" * 60)
    print(f"[merge] DONE")
    print(f"  pod runtime   : {runtime:.1f} min")
    print(f"  est cost      : ${cost:.2f}")
    print(f"  local cache   : data/cache/{cache_subdir}/")
    print("=" * 60)


# --------------------------------------------------------------------------- main

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(line_buffering=True)

    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--tag", default=time.strftime("%Y%m%d-%H%M%S"),
                   help="tag appended to pod/volume names (default: timestamp)")
    p.add_argument("--idle-timeout", type=int, default=15,
                   help="no-stdout idle timeout in MINUTES (default 15)")
    sub = p.add_subparsers(dest="mode", required=True)

    # prep-volume
    pp = sub.add_parser("prep-volume", help="create/reuse volume + pre-load dataset")
    pp.add_argument("--volume-size", type=int, default=100)
    pp.add_argument("--volume-id", default=None,
                    help="reuse this existing volume instead of creating a new one")
    pp.add_argument("--dataset", default="asl_citizen",
                    choices=("asl_citizen", "wlasl_raw"),
                    help="which dataset to land on the volume. asl_citizen "
                         "(default) downloads abd0kamel/asl-citizen to "
                         "/workspace/datasets/ASL_Citizen; wlasl_raw downloads "
                         "risangbaskoro/wlasl-processed to /workspace/datasets/wlasl.")
    pp.add_argument("--clean-kagglehub", action="store_true",
                    help="`rm -rf /workspace/.kagglehub` BEFORE downloading. "
                         "Guarded: only fires when /workspace/datasets/ASL_Citizen/videos/ "
                         "already exists and is non-empty (i.e. the in-flight "
                         "ASL Citizen extract has already taken what it needs "
                         "from the .kagglehub ZIP). Use this between back-to-back "
                         "kagglehub downloads to free volume space.")
    pp.add_argument("--source-pod-id", default=None,
                    help="ssh+tar pull videos FROM this live pod instead of "
                         "kagglehub-downloading")
    pp.add_argument("--pull-cache", action="store_true",
                    help="(with --source-pod-id) also pull the source pod's "
                         "in-progress data/cache/asl_citizen/ to /workspace/cache/")
    pp.add_argument("--source-key", default=None,
                    help="path to source pod's SSH private key (default: "
                         "auto-detect newest signchat-pod-* in tmp)")
    pp.add_argument("--timeout", type=int, default=60,
                    help="wall-clock timeout in MINUTES (default 60)")

    # extract-fanout
    pe = sub.add_parser("extract-fanout", help="N parallel CPU pods extract")
    pe.add_argument("--volume-id", required=True)
    pe.add_argument("--num-shards", type=int, default=DEFAULT_FANOUT_N,
                    help=f"number of parallel pods (default {DEFAULT_FANOUT_N})")
    pe.add_argument("--cpu-flavor", default=DEFAULT_CPU_FLAVOR,
                    help=f"CPU flavor id (default {DEFAULT_CPU_FLAVOR}; 5GHz Compute)")
    pe.add_argument("--vcpu", type=int, default=DEFAULT_VCPU,
                    help=f"vCPU count per pod (default {DEFAULT_VCPU})")
    pe.add_argument("--workers", type=int, default=16,
                    help="MediaPipe worker processes per pod (default 16; "
                         "tuned for 32 vCPU 5GHz to avoid mp-thread oversub)")
    pe.add_argument("--dataset", default="asl_citizen",
                    choices=("asl_citizen", "wlasl_raw"),
                    help="which loader to fan out (default asl_citizen). "
                         "wlasl_raw extracts the raw mp4s from "
                         "/workspace/datasets/wlasl that "
                         "`prep-volume --dataset wlasl_raw` landed on the volume.")
    pe.add_argument("--top-k", type=int, default=500,
                    help="top-K glosses for asl_citizen (ignored if --gloss-list)")
    pe.add_argument("--gloss-list", default=None,
                    help="path (relative to repo root) to a lexicon JSON for "
                         "targeted extraction; passed through to the loader.")
    pe.add_argument("--per-participant", action="store_true",
                    help="produce per-participant cache layout + participants.json "
                         "(required for custom signer-disjoint splits in the v2 "
                         "broad+tight recipe)")
    pe.add_argument("--container-disk-gb", type=int, default=PREP_CONTAINER_DISK_GB,
                    help=f"per-pod container disk size in GB (default {PREP_CONTAINER_DISK_GB}). "
                         "Small cpu3c-4/8 pods cap at 40 GB; lower this if you hit "
                         "'Container Disk must be less than or equal to 40' errors.")
    pe.add_argument("--timeout", type=int, default=180,
                    help="wall-clock timeout in MINUTES (default 180; "
                         "fan-out wall-time is typically 30-60 min)")

    # merge-and-fetch
    pm = sub.add_parser("merge-and-fetch", help="write done.txt + rsync cache down")
    pm.add_argument("--volume-id", required=True)
    pm.add_argument("--dataset", default="asl_citizen",
                    choices=("asl_citizen", "wlasl_raw"),
                    help="which cache subdir to merge + fetch (default asl_citizen). "
                         "wlasl_raw merges /workspace/cache/wlasl_full → "
                         "data/cache/wlasl_full.")
    pm.add_argument("--timeout", type=int, default=60,
                    help="wall-clock timeout in MINUTES (default 60)")

    args = p.parse_args()

    LOG_FILE.unlink(missing_ok=True)
    creds = load_credentials()
    rest = RunpodREST(creds.runpod_key)

    if args.mode == "prep-volume":
        cmd_prep_volume(args, creds, rest)
    elif args.mode == "extract-fanout":
        cmd_extract_fanout(args, creds, rest)
    elif args.mode == "merge-and-fetch":
        cmd_merge_and_fetch(args, creds, rest)
    else:
        sys.exit(f"unknown mode {args.mode}")


if __name__ == "__main__":
    main()
