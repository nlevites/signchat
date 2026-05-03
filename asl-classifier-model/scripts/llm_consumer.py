"""Live ASR-style LLM consumer for the contract layer's JSONL stream.

Reads JSONL events from stdin (or a file), maintains a rolling 30-second
window of `committed=True` events, and re-prompts an LLM whenever a new
commit lands. Output is the LLM's best-guess English sentence so far.

Usage:
    # Pipe live from the demo
    python -m src.realtime_demo --checkpoint pretrained/phase1_broad/ \
        --llm-bridge stdout \
    | python scripts/llm_consumer.py --provider claude --window-s 30

    # Replay an offline JSONL file
    python scripts/llm_consumer.py --provider gpt --file /tmp/run.jsonl

    # Dry-run (no API calls; just prints rolling committed words)
    python scripts/llm_consumer.py --provider none --file /tmp/run.jsonl

Providers:
    none       — print committed words; no LLM call. Useful for sanity-checking
                 the contract layer's commit cadence without API spend.
    claude     — Anthropic Claude (requires ANTHROPIC_API_KEY env var).
    gpt        — OpenAI GPT (requires OPENAI_API_KEY env var).

The script does NOT install the anthropic/openai SDKs eagerly; they're imported
on first use, so the `none` provider works with no extra deps.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import deque
from typing import Iterator


SYSTEM_PROMPT = (
    "You convert a stream of recognized American Sign Language word glosses "
    "into a fluent, grammatical English sentence. Each input is a list of "
    "glosses recently committed by an ASL recognition model, in chronological "
    "order. Each gloss is a single English word, sometimes with an alternate "
    "gloss (separated by '|'). ASL omits articles, copulas, and many function "
    "words; your job is to add them and produce a natural English sentence. "
    "If the recent commits don't form a coherent thought yet, output a "
    "fragment that respects the order. Keep it short. Reply with only the "
    "sentence; no commentary."
)


def _committed_iter(stream) -> Iterator[dict]:
    """Yield only ``committed=True`` events from a JSONL stream."""
    for line in stream:
        line = line.strip()
        if not line:
            continue
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("committed"):
            yield ev


def _format_window(window: list[dict]) -> str:
    """Turn a list of committed events into the LLM prompt payload."""
    parts: list[str] = []
    for ev in window:
        topk = ev.get("top_k") or []
        if not topk:
            continue
        primary = topk[0][0]
        # Include up to one alternate if it's at least 60% as confident as the primary
        if len(topk) >= 2 and topk[0][1] > 0 and topk[1][1] / topk[0][1] > 0.6:
            parts.append(f"{primary}|{topk[1][0]}")
        else:
            parts.append(primary)
    return ", ".join(parts) if parts else "(no signs yet)"


def _call_claude(payload: str) -> str:
    try:
        import anthropic
    except ImportError:
        return "ERROR: pip install anthropic"
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return "ERROR: ANTHROPIC_API_KEY not set"
    client = anthropic.Anthropic(api_key=api_key)
    rsp = client.messages.create(
        model=os.environ.get("CLAUDE_MODEL", "claude-3-5-sonnet-latest"),
        max_tokens=100,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": f"Recent ASL commits: {payload}"}],
    )
    return rsp.content[0].text.strip()


def _call_gpt(payload: str) -> str:
    try:
        from openai import OpenAI
    except ImportError:
        return "ERROR: pip install openai"
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return "ERROR: OPENAI_API_KEY not set"
    client = OpenAI(api_key=api_key)
    rsp = client.chat.completions.create(
        model=os.environ.get("OPENAI_MODEL", "gpt-4o-mini"),
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user",   "content": f"Recent ASL commits: {payload}"},
        ],
        max_tokens=100,
    )
    return rsp.choices[0].message.content.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--provider", choices=("none", "claude", "gpt"),
                        default="none",
                        help="LLM provider (default 'none' = no API call)")
    parser.add_argument("--file", default=None,
                        help="read JSONL from this file (default: stdin)")
    parser.add_argument("--window-s", type=float, default=30.0,
                        help="rolling window in seconds (default 30)")
    parser.add_argument("--min-commits", type=int, default=2,
                        help="don't call LLM until window has at least this "
                             "many commits (default 2)")
    args = parser.parse_args()

    stream = open(args.file) if args.file else sys.stdin
    window: deque[dict] = deque()
    last_call_t = 0.0
    last_call_n_commits = 0

    if args.provider == "claude":
        provider_fn = _call_claude
    elif args.provider == "gpt":
        provider_fn = _call_gpt
    else:
        provider_fn = None

    print(f"[llm-consumer] provider={args.provider} window_s={args.window_s} "
          f"min_commits={args.min_commits}", file=sys.stderr)

    try:
        for ev in _committed_iter(stream):
            now_ms = ev.get("t_ms", int(time.time() * 1000))
            window.append(ev)
            # Drop events older than window-s.
            cutoff_ms = now_ms - int(args.window_s * 1000)
            while window and window[0].get("t_ms", 0) < cutoff_ms:
                window.popleft()
            if len(window) < args.min_commits:
                if provider_fn is None:
                    print(f"[committed] {ev['top_k'][0][0]}  "
                          f"window={[e['top_k'][0][0] for e in window]}")
                continue

            payload = _format_window(list(window))
            if provider_fn is None:
                print(f"[window] {payload}")
                continue
            # Don't spam the LLM if commits arrive faster than ~1 per 800ms.
            now_s = time.time()
            if (now_s - last_call_t < 0.8
                    and len(window) == last_call_n_commits):
                continue
            last_call_t = now_s
            last_call_n_commits = len(window)
            try:
                sentence = provider_fn(payload)
            except Exception as e:
                sentence = f"ERROR: {type(e).__name__}: {e}"
            print(f"[llm] {sentence}  ({len(window)} commits in window)")
    finally:
        if stream is not sys.stdin:
            stream.close()


if __name__ == "__main__":
    main()
