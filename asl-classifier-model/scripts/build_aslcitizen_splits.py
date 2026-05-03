"""Generate `data/splits/asl_citizen.json` from a per-participant cache.

Reads `participants.json` (written by `src/data/asl_citizen_loader.py`
when invoked with `--per-participant`) and assigns each ASL Citizen
participant to one of three signer-disjoint cohorts:

  * train_signers     -- the bulk of participants (default ~80%)
  * val_signers       -- validation cohort (~10%); used by the trainer's
                         val_acc metric for early-stopping/checkpointing
  * held_out_signers  -- ultimate held-out cohort (~10%); reported as
                         val_signer_acc in experiments.csv (the metric we
                         actually rank Phase 1 runs on)

The output JSON also includes signer-id strings for the WLASL and (future)
MS-ASL caches via simple defaults, so the same `splits_path` works for the
multi-cache_dir Phase 1 broad/tight configs.

Why this exists: ASL Citizen ships official train/val/test splits that
divide BY CLIP within each split, not by signer. Using the official splits
in our pipeline costs us ~2x training data because we'd have to leave 50%
of clips in val+test out of training. The ASL Citizen paper uses signer
disjointness as the core evaluation principle anyway, so picking our own
signer cohort is consistent with their methodology and unlocks all 84K
clips for training (modulo our 5-7 held-out signers).

CLI:
    python scripts/build_aslcitizen_splits.py \\
        --participants data/cache/asl_citizen/participants.json \\
        --out data/splits/asl_citizen.json \\
        --val-signers 5 --held-out-signers 5 --seed 42
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path


def _signer_id(pid: str) -> str:
    """Match the cache subdir name written by asl_citizen_loader.py."""
    return f"participant_{pid}"


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--participants", type=Path,
                   default=Path("data/cache/asl_citizen/participants.json"),
                   help="participants.json written by asl_citizen_loader.py "
                        "with --per-participant (default: data/cache/asl_citizen/participants.json)")
    p.add_argument("--out", type=Path,
                   default=Path("data/splits/asl_citizen.json"),
                   help="output splits JSON")
    p.add_argument("--val-signers", type=int, default=5,
                   help="number of participants in val_signers (default 5)")
    p.add_argument("--held-out-signers", type=int, default=5,
                   help="number of participants in held_out_signers (default 5)")
    p.add_argument("--seed", type=int, default=42,
                   help="RNG seed for the deterministic shuffle")
    p.add_argument("--prefer-test-as-held-out", action="store_true",
                   help="seed held_out_signers from participants whose official "
                        "ASL Citizen split is 'test'; falls through to a random "
                        "draw if not enough test-split participants exist. Gives "
                        "us a small loose comparability with the ASL Citizen "
                        "paper's reported metrics.")
    p.add_argument("--include-wlasl", action="store_true", default=True,
                   help="include WLASL/MuteMotion signer ids (wlasl_train, "
                        "wlasl_val, wlasl_test) in the splits so the multi-cache "
                        "Phase 1 broad config works against the same JSON")
    p.add_argument("--include-wlasl-raw", action="store_true",
                   help="include WLASL2000 raw extract signer ids "
                        "(participant_w<signer_id>) read from "
                        "data/cache/wlasl_full/participants.json. Partitions "
                        "the WLASL signers into the same train/val/held cohorts "
                        "as ASL Citizen using --val-signers-wlasl-raw and "
                        "--held-out-signers-wlasl-raw counts.")
    p.add_argument("--wlasl-raw-participants", type=Path,
                   default=Path("data/cache/wlasl_full/participants.json"),
                   help="path to wlasl_raw participants.json")
    p.add_argument("--val-signers-wlasl-raw", type=int, default=12,
                   help="WLASL signer count for val_signers (default 12; "
                        "WLASL has ~120 unique signer ids so ~10 percent)")
    p.add_argument("--held-out-signers-wlasl-raw", type=int, default=12,
                   help="WLASL signer count for held_out_signers (default 12)")
    p.add_argument("--include-kaggle-islr", action="store_true",
                   help="include Kaggle ISLR signer ids (kaggle_p<id>) read from "
                        "data/splits/kaggle_islr.json (which the loader writes "
                        "with its own per-participant split). Kaggle ISLR has "
                        "~21 participants total; the loader picks ~13/4/4 by "
                        "default. We just import those into our combined splits.")
    p.add_argument("--kaggle-islr-splits", type=Path,
                   default=Path("data/splits/kaggle_islr.json"),
                   help="path to kaggle_islr.json (the standalone splits file "
                        "written by src/data/kaggle_islr_loader.py)")
    args = p.parse_args()

    if not args.participants.exists():
        sys.exit(
            f"ERROR: participants.json not found at {args.participants}.\n"
            "Run `python -m src.data.asl_citizen_loader --gloss-list ... "
            "--per-participant` first to produce it."
        )
    pdata: dict[str, dict] = json.loads(args.participants.read_text())
    if not pdata:
        sys.exit(f"ERROR: {args.participants} is empty")

    rng = random.Random(args.seed)
    pids = sorted(pdata.keys())

    # Cohort selection.
    held_pool: list[str] = []
    if args.prefer_test_as_held_out:
        test_pids = [pid for pid in pids if pdata[pid].get("official_split") == "test"]
        rng.shuffle(test_pids)
        held_pool = test_pids[:args.held_out_signers]
    if len(held_pool) < args.held_out_signers:
        # Fill from remaining pids.
        remaining = [pid for pid in pids if pid not in held_pool]
        rng.shuffle(remaining)
        held_pool += remaining[:args.held_out_signers - len(held_pool)]
    held_set = set(held_pool)
    val_pool_src = [pid for pid in pids if pid not in held_set]
    rng.shuffle(val_pool_src)
    val_pool = val_pool_src[:args.val_signers]
    val_set = set(val_pool)
    train_pool = [pid for pid in pids if pid not in held_set and pid not in val_set]

    splits = {
        "_comment": "Custom signer-disjoint cohort over ASL Citizen participants. "
                    "Combines train+val+test from ASL Citizen's official splits "
                    "into one training pool, then carves val/held_out by Participant "
                    "ID. Generated by scripts/build_aslcitizen_splits.py.",
        "_source": str(args.participants),
        "_seed": args.seed,
        "train_signers": [_signer_id(p) for p in sorted(train_pool)],
        "val_signers": [_signer_id(p) for p in sorted(val_pool)],
        "held_out_signers": [_signer_id(p) for p in sorted(held_pool)],
        "random_seed": args.seed,
    }
    if args.include_wlasl:
        splits["train_signers"].extend(["wlasl_train"])
        splits["val_signers"].extend(["wlasl_val"])
        splits["held_out_signers"].extend(["wlasl_test"])

    wlasl_raw_added = (0, 0, 0)
    if args.include_wlasl_raw:
        if not args.wlasl_raw_participants.exists():
            print(f"[build-splits] WARN --include-wlasl-raw requested but "
                  f"{args.wlasl_raw_participants} does not exist; skipping. "
                  "Run `make pod-extract-wlasl-raw-merge` first.",
                  file=sys.stderr)
        else:
            wlasl_pdata: dict[str, dict] = json.loads(
                args.wlasl_raw_participants.read_text())
            wlasl_pids = sorted(wlasl_pdata.keys())
            rng_w = random.Random(args.seed + 1)  # decoupled seed
            rng_w.shuffle(wlasl_pids)
            n_held = min(args.held_out_signers_wlasl_raw, len(wlasl_pids) // 3)
            n_val = min(args.val_signers_wlasl_raw,
                        max(0, len(wlasl_pids) - n_held - 1))
            held_w = sorted(wlasl_pids[:n_held])
            val_w = sorted(wlasl_pids[n_held:n_held + n_val])
            train_w = sorted(wlasl_pids[n_held + n_val:])
            splits["train_signers"].extend(f"participant_w{p}" for p in train_w)
            splits["val_signers"].extend(f"participant_w{p}" for p in val_w)
            splits["held_out_signers"].extend(f"participant_w{p}" for p in held_w)
            wlasl_raw_added = (len(train_w), len(val_w), len(held_w))

    kaggle_added = (0, 0, 0)
    if args.include_kaggle_islr:
        if not args.kaggle_islr_splits.exists():
            print(f"[build-splits] WARN --include-kaggle-islr requested but "
                  f"{args.kaggle_islr_splits} does not exist; skipping. "
                  "Run the kaggle_islr_loader first.",
                  file=sys.stderr)
        else:
            kdata = json.loads(args.kaggle_islr_splits.read_text())
            for cohort_key in ("train_signers", "val_signers", "held_out_signers"):
                splits[cohort_key].extend(kdata.get(cohort_key, []))
            kaggle_added = (
                len(kdata.get("train_signers", [])),
                len(kdata.get("val_signers", [])),
                len(kdata.get("held_out_signers", [])),
            )

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(splits, indent=2))

    print(f"[build-splits] wrote {args.out}")
    print(f"  participants: {len(pids)} total")
    print(f"  train: {len(train_pool)} ASL Citizen participants " +
          (f"+ wlasl_train" if args.include_wlasl else "") +
          (f" + {wlasl_raw_added[0]} wlasl_raw signers" if args.include_wlasl_raw else "") +
          (f" + {kaggle_added[0]} kaggle_islr signers" if args.include_kaggle_islr else ""))
    print(f"  val:   {len(val_pool)} ASL Citizen participants " +
          (f"+ wlasl_val" if args.include_wlasl else "") +
          (f" + {wlasl_raw_added[1]} wlasl_raw signers" if args.include_wlasl_raw else "") +
          (f" + {kaggle_added[1]} kaggle_islr signers" if args.include_kaggle_islr else ""))
    print(f"  held:  {len(held_pool)} ASL Citizen participants " +
          (f"+ wlasl_test" if args.include_wlasl else "") +
          (f" + {wlasl_raw_added[2]} wlasl_raw signers" if args.include_wlasl_raw else "") +
          (f" + {kaggle_added[2]} kaggle_islr signers" if args.include_kaggle_islr else ""))
    print(f"  cohort distribution by official-split:")
    for cohort, members in (("train", train_pool),
                             ("val", val_pool),
                             ("held", held_pool)):
        by_split: dict[str, int] = {}
        for pid in members:
            by_split[pdata[pid].get("official_split", "?")] = \
                by_split.get(pdata[pid].get("official_split", "?"), 0) + 1
        print(f"    {cohort}: {by_split}")


if __name__ == "__main__":
    main()
