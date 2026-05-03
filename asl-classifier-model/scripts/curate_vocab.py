"""Curate the tight-cut vocabulary for the Phase 1 demo model.

Two modes:

* ``--analyze``: scan one or more cache directories (each with a ``vocab.json``
  and ``<dataset>_<split>/<gloss>/*.npy`` clips), match a target lexicon
  (default: ``data/vocab/coffee_chat.json``) plus an optional backup pool
  (``data/vocab/coffee_chat_backup.json``) against the cache, and print a
  coverage report. No writes.

* ``--write-tight-vocab <path>``: same matching as ``--analyze`` but also
  materialize the FINAL tight-cut ``vocab.json`` (the resolved
  dataset-specific gloss strings, in the lexicon's display order) for
  downstream training. Each entry that fails the per-class density gate is
  substituted from the backup pool when possible; if the substitution chain
  is exhausted, the slot is dropped and a WARN is printed.

Why this exists: the previous Phase 1 baseline trained on an 864-class union
softmax with ~12 clips/class average. Per-class data thinness was the
dominant failure mode of the original wide-vocab pretrain. The tight-cut
recipe replaces that with a small, dense softmax (~25 classes, >=20
clips/class) whose vocab is hand-picked for the demo script.

Cross-dataset gloss conventions are noisy:

  * ASL Citizen uses ALL_CAPS with ASL-LEX numeric variant suffixes:
    ``DEAF1``, ``EAT1``, ``LOVE1``, plus a few non-suffixed (``MOTHER``,
    ``APPLE``, ``WORK``).
  * WLASL via MuteMotion uses lowercase: ``family``, ``deaf``, ``coffee``.
  * Hyphenated English (``THANK-YOU``) maps to concatenated dataset glosses
    (``THANKYOU`` / ``thankyou``).

For each lexicon entry we generate a small alias set covering all observed
conventions and pick the FIRST cache match by alias precedence (caller
order: ASL Citizen, then WLASL, then MS-ASL when added). When multiple
numeric variants exist (``DEAF1`` vs ``DEAF2``), prefer the lowest-numbered
variant since lower numbers are typically the most-cited / canonical.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path

# Make `src.*` importable when running as a top-level script.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.data.gloss_aliases import expand_aliases as _expand_aliases  # noqa: E402


# --------------------------------------------------------------------------- cache scan

def _load_lexicon(path: Path) -> tuple[str, list[str]]:
    """Return ``(name, signs)`` from a lexicon JSON file."""
    if not path.exists():
        sys.exit(f"ERROR: lexicon not found: {path}")
    data = json.loads(path.read_text())
    if isinstance(data, list):
        return (path.stem, data)
    return (data.get("name", path.stem), list(data["signs"]))


def _load_cache_vocab(cache_dir: Path) -> list[str]:
    """Return the cache's vocab list from ``<cache_dir>/vocab.json``."""
    vj = cache_dir / "vocab.json"
    if not vj.exists():
        return []
    data = json.loads(vj.read_text())
    return data["vocab"] if isinstance(data, dict) else list(data)


def _count_clips_per_gloss(cache_dir: Path) -> dict[str, dict[str, int]]:
    """Return ``{gloss: {split_name: clip_count}}`` for every gloss directory.

    Uses ``done.txt`` if present (cheap), else falls back to globbing ``*.npy``
    (slower but correct on partial extracts). Split name is the first-level
    directory under the cache root, e.g. ``asl_citizen_train``.
    """
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    if not cache_dir.exists():
        return counts
    for split_dir in sorted(cache_dir.iterdir()):
        if not split_dir.is_dir():
            continue
        for gloss_dir in sorted(split_dir.iterdir()):
            if not gloss_dir.is_dir():
                continue
            done = gloss_dir / "done.txt"
            if done.exists():
                try:
                    n = int(done.read_text().strip().split()[0])
                except (ValueError, IndexError):
                    n = sum(1 for _ in gloss_dir.glob("*.npy"))
            else:
                n = sum(1 for _ in gloss_dir.glob("*.npy"))
            if n:
                counts[gloss_dir.name][split_dir.name] = n
    return counts


def _signers_per_gloss(cache_dir: Path) -> dict[str, set[str]]:
    """Return ``{gloss: {signer_id, ...}}``.

    For our cache layout ``signer_id`` is the SPLIT directory name
    (``asl_citizen_train``, ``wlasl_val``, ...) since per-clip signer ids
    aren't tracked at the filename level. So "signer count" is really
    "split count" here, which is the right quantity for the
    ``MIN_VAL_SIGNERS`` gate (we want the gloss to appear in val/val_signer
    splits, not just train).
    """
    out: dict[str, set[str]] = defaultdict(set)
    if not cache_dir.exists():
        return out
    for split_dir in sorted(cache_dir.iterdir()):
        if not split_dir.is_dir():
            continue
        for gloss_dir in sorted(split_dir.iterdir()):
            if not gloss_dir.is_dir():
                continue
            if any(True for _ in gloss_dir.glob("*.npy")):
                out[gloss_dir.name].add(split_dir.name)
    return out


# --------------------------------------------------------------------------- matching

def _resolve_one(label: str, aliases: list[str], cache_vocabs: list[list[str]]
                 ) -> tuple[str, str] | tuple[None, None]:
    """Pick the best (cache_index, gloss) for ``label`` across caches.

    For each alias in priority order, scan caches in caller order. Returns
    on first match (alias precedence dominates cache precedence so that
    e.g. ``DEAF1`` in ASL Citizen is chosen over ``deaf`` in WLASL). The
    cache_index is "<cache0>", "<cache1>" etc; resolve to a path via the
    caller's cache_dirs list.
    """
    for alias in aliases:
        for ci, vocab in enumerate(cache_vocabs):
            if alias in vocab:
                return (str(ci), alias)
    return (None, None)


def _density_for(gloss: str, counts: dict[str, dict[str, int]]
                 ) -> tuple[int, int, dict[str, int]]:
    """Return (train_clips, n_val_signers_aka_splits, full_per_split_dict)."""
    splits = counts.get(gloss, {})
    train = sum(v for k, v in splits.items() if k.endswith("_train"))
    val_split_count = sum(1 for k in splits if not k.endswith("_train") and splits[k] > 0)
    return train, val_split_count, dict(splits)


# --------------------------------------------------------------------------- report

def _fmt_split_counts(d: dict[str, int]) -> str:
    if not d:
        return "(none)"
    parts = []
    for k in sorted(d):
        parts.append(f"{k.replace('asl_citizen_', 'ac/').replace('wlasl_', 'wl/')}={d[k]}")
    return " ".join(parts)


def _analyze(lexicon_name: str, signs: list[str], cache_dirs: list[Path],
             min_train_clips: int, min_val_signers: int,
             header: str) -> tuple[list[dict], dict]:
    """Run the matching pass; print a per-sign report. Returns (report_rows,
    summary) where each row is {sign, alias, cache_index, train, val_splits,
    pass}.
    """
    cache_vocabs = [set(_load_cache_vocab(d)) for d in cache_dirs]
    cache_counts = [_count_clips_per_gloss(d) for d in cache_dirs]

    print(f"\n=== {header}: {lexicon_name} ({len(signs)} signs) ===")
    print(f"Caches: " + ", ".join(
        f"[{i}] {d} (vocab={len(cache_vocabs[i])})"
        for i, d in enumerate(cache_dirs)
    ))
    print(f"Gates: train >= {min_train_clips}, val-or-val_signer splits >= {min_val_signers}")
    print()
    print(f"{'Sign':<14} {'Match':<14} {'Cache':<6} {'Train':>6} {'ValSplits':>10}  Splits")
    print("-" * 90)

    rows: list[dict] = []
    n_pass = n_match_only = n_miss = 0
    for sign in signs:
        aliases = _expand_aliases(sign)
        ci, alias = _resolve_one(sign, aliases, [list(v) for v in cache_vocabs])
        if alias is None:
            print(f"{sign:<14} {'-':<14} {'-':<6} {'-':>6} {'-':>10}  MISSING from all caches")
            rows.append({"sign": sign, "alias": None, "cache_index": None,
                         "train": 0, "val_splits": 0, "pass": False})
            n_miss += 1
            continue
        train, val_splits, split_dict = _density_for(alias, cache_counts[int(ci)])
        passed = train >= min_train_clips and val_splits >= min_val_signers
        marker = "OK" if passed else "weak"
        print(f"{sign:<14} {alias:<14} {ci:<6} {train:>6} {val_splits:>10}  "
              f"[{marker}] {_fmt_split_counts(split_dict)}")
        rows.append({"sign": sign, "alias": alias, "cache_index": ci,
                     "train": train, "val_splits": val_splits, "pass": passed,
                     "splits": split_dict})
        if passed:
            n_pass += 1
        else:
            n_match_only += 1

    print()
    print(f"Summary: {n_pass}/{len(signs)} pass density gates, "
          f"{n_match_only} matched-but-weak, {n_miss} missing from all caches")
    return rows, {"pass": n_pass, "weak": n_match_only, "missing": n_miss,
                  "total": len(signs)}


def _histogram(cache_dirs: list[Path]):
    """Print a clips/class histogram across all glosses in all caches."""
    print("\n=== Clips/class histogram (all glosses, all caches) ===")
    bins = [0, 5, 10, 15, 20, 30, 50, 100, 200, 500, 10**9]
    labels = [f"<{bins[i+1]}" for i in range(len(bins) - 1)]
    labels[-1] = f">={bins[-2]}"
    for cache_dir in cache_dirs:
        cnts = _count_clips_per_gloss(cache_dir)
        train_only: list[int] = []
        for gloss, splits in cnts.items():
            train = sum(v for k, v in splits.items() if k.endswith("_train"))
            train_only.append(train)
        if not train_only:
            print(f"  {cache_dir}: (no clips)")
            continue
        buckets = Counter()
        for n in train_only:
            for i in range(len(bins) - 1):
                if bins[i] <= n < bins[i + 1]:
                    buckets[labels[i]] += 1
                    break
        cumulative = 0
        print(f"  {cache_dir}: {len(train_only)} glosses, "
              f"{sum(train_only)} total train clips, "
              f"mean={sum(train_only)/len(train_only):.1f}, "
              f"median={sorted(train_only)[len(train_only)//2]}")
        for lab in labels:
            n = buckets.get(lab, 0)
            cumulative += n
            print(f"    train_clips {lab:>6}: {n:>4} glosses ({cumulative:>4} cumulative)")


# --------------------------------------------------------------------------- write tight

def _write_tight_vocab(out_path: Path, primary_rows: list[dict],
                       backup_rows: list[dict]):
    """Materialize a vocab.json containing the resolved gloss strings.

    Substitution rule: keep primary rows that pass; for each primary that
    FAILS (weak or missing), pull the next unused PASSING backup row. Drop
    slots if the backup pool is exhausted. The output is in primary order
    with substitutions inlined at the failed positions.
    """
    backup_pool = [r for r in backup_rows if r.get("pass") and r.get("alias")]
    bp_idx = 0
    final: list[str] = []
    sub_log: list[tuple[str, str | None]] = []

    for row in primary_rows:
        if row.get("pass") and row.get("alias"):
            final.append(row["alias"])
            sub_log.append((row["sign"], row["alias"]))
        else:
            if bp_idx < len(backup_pool):
                rep = backup_pool[bp_idx]
                bp_idx += 1
                final.append(rep["alias"])
                sub_log.append((row["sign"], f"-> backup {rep['sign']} ({rep['alias']})"))
            else:
                sub_log.append((row["sign"], None))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        "vocab": final,
        "size": len(final),
        "source": "scripts/curate_vocab.py --write-tight-vocab",
        "substitutions": [{"sign": s, "resolved": r} for s, r in sub_log],
    }, indent=2))
    print(f"\n[write-tight-vocab] wrote {out_path} ({len(final)} signs)")
    for sign, resolved in sub_log:
        if resolved is None:
            print(f"  DROPPED {sign} (no backup available)")
        elif resolved.startswith("-> backup"):
            print(f"  SUB     {sign:<14} {resolved}")


# --------------------------------------------------------------------------- main

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--analyze", action="store_true",
                   help="print coverage report; no writes")
    p.add_argument("--write-tight-vocab", type=Path, default=None,
                   help="materialize the FINAL tight-cut vocab.json at this path")
    p.add_argument("--cache-dirs", nargs="+", type=Path, required=True,
                   help="cache directories to scan (each must have vocab.json)")
    p.add_argument("--demo-vocab", type=Path,
                   default=Path("data/vocab/coffee_chat.json"),
                   help="primary lexicon to score (default: Coffee Chat)")
    p.add_argument("--backup-pool", type=Path,
                   default=Path("data/vocab/coffee_chat_backup.json"),
                   help="backup pool for substitutions when primary signs fail")
    p.add_argument("--min-train-clips", type=int, default=20,
                   help="density gate: minimum train clips per class")
    p.add_argument("--min-val-signers", type=int, default=2,
                   help="density gate: minimum val-or-val_signer split count")
    args = p.parse_args()

    if not args.analyze and args.write_tight_vocab is None:
        sys.exit("ERROR: pass --analyze or --write-tight-vocab (or both)")

    primary_name, primary_signs = _load_lexicon(args.demo_vocab)
    backup_name, backup_signs = (None, [])
    if args.backup_pool and args.backup_pool.exists():
        backup_name, backup_signs = _load_lexicon(args.backup_pool)

    primary_rows, primary_summary = _analyze(
        primary_name, primary_signs, args.cache_dirs,
        args.min_train_clips, args.min_val_signers,
        header="Primary lexicon",
    )
    backup_rows = []
    if backup_signs:
        backup_rows, _ = _analyze(
            backup_name, backup_signs, args.cache_dirs,
            args.min_train_clips, args.min_val_signers,
            header="Backup pool",
        )

    if args.analyze:
        _histogram(args.cache_dirs)
        # Recommendations
        n_pass = primary_summary["pass"]
        n_total = primary_summary["total"]
        n_failing = n_total - n_pass
        backup_passing = sum(1 for r in backup_rows if r.get("pass"))
        print("\n=== Recommendations ===")
        if n_failing == 0:
            print("  All primary signs pass. Ready to materialize tight vocab.")
        else:
            print(f"  {n_failing} primary signs fail the density gate.")
            print(f"  Backup pool has {backup_passing} passing entries available for substitution.")
            if backup_passing >= n_failing:
                print("  -> Substitution can fully cover the gap.")
            else:
                shortfall = n_failing - backup_passing
                print(f"  -> Substitution covers only {backup_passing} of {n_failing}; "
                      f"{shortfall} slots will be DROPPED unless we re-extract.")
            if n_failing >= 5:
                print("  -> Per the plan's gate (>=5 failing), MANDATORY re-extract at higher top-K.")
            else:
                print("  -> Below the >=5 mandatory-re-extract threshold; substitution may suffice.")

    if args.write_tight_vocab is not None:
        _write_tight_vocab(args.write_tight_vocab, primary_rows, backup_rows)


if __name__ == "__main__":
    main()
