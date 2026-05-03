"""JSONL bridge between the contract state machine and a downstream LLM client.

One JSON object per line per inference tick. The realtime demo selects the
sink via ``--llm-bridge {none,stdout,jsonl-file:PATH}``:

  * ``none``        — silent (default; preserves the standard demo UX).
  * ``stdout``      — emit to stdout. Pipe into a small Python/Node script
                      that maintains a rolling 30-second window of committed
                      events and calls Claude/GPT to compose English.
  * ``jsonl-file:PATH`` — append to PATH (creates parent dirs as needed). Lets
                      another process tail -F it; useful for offline replay
                      and for separating UI logs from LLM signal.

The wire format is the JSON serialization of ``contract.TickEvent`` (one
object per line). All fields are guaranteed JSON-safe (no numpy types). See
``src/contract.py`` for the field definitions and the commit/release semantics
the LLM should rely on.

Helper for LLM consumers:

    from src.llm_bridge import parse_event, stream_committed_only
    for line in sys.stdin:
        ev = parse_event(line)
        if ev["committed"]:
            ...

The committed/stable distinction is critical: most LLM clients should
consume ONLY ``committed=True`` events as token-level input. Non-committed
events are observability/debug.
"""

from __future__ import annotations

import json
import sys
from dataclasses import is_dataclass
from pathlib import Path
from typing import IO, Iterable, Iterator, Optional

from .contract import TickEvent


# --------------------------------------------------------------------------- emitters

class JsonlSink:
    """Wraps an output stream (stdout, a file, etc.) with line-flushing JSONL writes.

    Use as a context manager:

        with JsonlSink.from_spec("stdout") as sink:
            sink.emit(event)
    """

    def __init__(self, fp: IO, owns_fp: bool = False, label: str = "?"):
        self._fp = fp
        self._owns_fp = owns_fp
        self._label = label

    @classmethod
    def from_spec(cls, spec: Optional[str]) -> Optional["JsonlSink"]:
        """Parse a CLI spec string and open the sink.

        spec values:
          * None or "" or "none"        -> returns None (no emission)
          * "stdout"                    -> wraps sys.stdout (no close)
          * "stderr"                    -> wraps sys.stderr (no close)
          * "jsonl-file:<path>"         -> opens <path> for append; close on exit
          * "<path>" (must end in .jsonl) -> same as jsonl-file:<path>
        """
        if not spec or spec.lower() in ("", "none"):
            return None
        if spec == "stdout":
            return cls(sys.stdout, owns_fp=False, label="stdout")
        if spec == "stderr":
            return cls(sys.stderr, owns_fp=False, label="stderr")
        path_str = spec
        if path_str.startswith("jsonl-file:"):
            path_str = path_str[len("jsonl-file:"):]
        path = Path(path_str)
        if path.suffix not in (".jsonl", ".ndjson", ".log"):
            # Not strictly required but a UX guard against accidental
            # `--llm-bridge stdout` typos that try to overwrite a non-jsonl file.
            print(f"[llm-bridge] WARN sink path {path} doesn't have a .jsonl/"
                  ".ndjson/.log extension; appending anyway",
                  file=sys.stderr)
        path.parent.mkdir(parents=True, exist_ok=True)
        fp = path.open("a", buffering=1)  # line-buffered
        return cls(fp, owns_fp=True, label=str(path))

    def emit(self, event: TickEvent) -> None:
        """Write one event as a JSONL line."""
        if is_dataclass(event):
            payload = event.to_dict()
        else:
            payload = dict(event)
        # ensure_ascii=False so emoji etc in glosses survive intact; sort_keys
        # so diffs in offline replay are stable.
        line = json.dumps(payload, ensure_ascii=False, sort_keys=True)
        self._fp.write(line + "\n")
        try:
            self._fp.flush()
        except Exception:
            pass

    def close(self) -> None:
        if self._owns_fp:
            try:
                self._fp.close()
            except Exception:
                pass

    def __enter__(self) -> "JsonlSink":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def __repr__(self) -> str:
        return f"JsonlSink(label={self._label!r}, owns_fp={self._owns_fp})"


def emit_jsonl(event: TickEvent, out: IO = sys.stdout) -> None:
    """One-shot helper: serialize ``event`` to ``out`` as a JSONL line."""
    if is_dataclass(event):
        payload = event.to_dict()
    else:
        payload = dict(event)
    out.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
    try:
        out.flush()
    except Exception:
        pass


# --------------------------------------------------------------------------- consumers

def parse_event(line: str) -> dict:
    """Parse one JSONL line into a dict. The shape matches ``TickEvent.to_dict()``."""
    return json.loads(line)


def stream_committed_only(events: Iterable) -> Iterator[dict]:
    """Filter for ``committed`` events only. Accepts dicts, parsed JSON, or
    TickEvent objects.

    Convenience for the LLM client side:

        import sys
        from src.llm_bridge import parse_event, stream_committed_only
        for ev in stream_committed_only(parse_event(line) for line in sys.stdin):
            print(ev["top_k"][0][0])  # the committed word
    """
    for ev in events:
        if isinstance(ev, dict):
            if ev.get("committed"):
                yield ev
        elif isinstance(ev, TickEvent):
            if ev.committed:
                yield ev.to_dict()
        else:
            raise TypeError(f"unsupported event type: {type(ev)!r}")


# --------------------------------------------------------------------------- demo CLI

def _demo():
    """Manually invokable from the command line as a smoke test:

        python -m src.llm_bridge --demo
        python -m src.llm_bridge --demo --sink jsonl-file:/tmp/test.jsonl
    """
    import argparse
    from .contract import ContractConfig, ContractStateMachine
    import numpy as np

    parser = argparse.ArgumentParser()
    parser.add_argument("--sink", default="stdout",
                        help="sink spec; see JsonlSink.from_spec docstring")
    args = parser.parse_args()

    vocab = ["MILK", "COFFEE", "DRINK", "PLEASE", "THANKS"]
    sm = ContractStateMachine(vocab, ContractConfig(stability_k=3))

    def fake_probs(top_word, top_p):
        p = np.full(len(vocab), (1 - top_p) / (len(vocab) - 1), dtype=np.float32)
        p[vocab.index(top_word)] = top_p
        return p

    sink = JsonlSink.from_spec(args.sink)
    if sink is None:
        print("ERROR: sink is None; pass --sink stdout or a path", file=sys.stderr)
        sys.exit(1)
    with sink:
        for i in range(8):
            sink.emit(sm.update(t_ms=i*100, probs=fake_probs("MILK", 0.8),
                                 motion_energy=0.2))
        for i in range(5):
            sink.emit(sm.update(t_ms=(8+i)*100, probs=None, motion_energy=0.0))
        for i in range(8):
            sink.emit(sm.update(t_ms=(13+i)*100, probs=fake_probs("COFFEE", 0.85),
                                 motion_energy=0.2))


if __name__ == "__main__":
    _demo()
