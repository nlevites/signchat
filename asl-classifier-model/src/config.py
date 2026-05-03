"""YAML config loader with single-level inheritance via `extends:`.

Usage:
    cfg = load_config("configs/pretrain_phase1_kaggle.yaml")
    print(cfg["model"]["dim"])
"""

from __future__ import annotations

import copy
from pathlib import Path
from typing import Any

import yaml


def _deep_merge(base: dict, override: dict) -> dict:
    """Recursively merge `override` into a copy of `base`."""
    out = copy.deepcopy(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def load_config(path: str | Path) -> dict[str, Any]:
    path = Path(path)
    with path.open() as f:
        raw = yaml.safe_load(f) or {}

    parent_name = raw.pop("extends", None)
    if parent_name is None:
        return raw
    parent_path = path.parent / parent_name
    parent = load_config(parent_path)
    return _deep_merge(parent, raw)
