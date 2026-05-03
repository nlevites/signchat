"""Cross-dataset gloss alias expansion.

Different sign-language datasets use different gloss conventions:

  * ASL Citizen uses ALL_CAPS with ASL-LEX numeric variant suffixes
    (``DEAF1``, ``EAT1``, ``LOVE1``) plus a few non-suffixed
    (``MOTHER``, ``APPLE``, ``WORK``).
  * WLASL via MuteMotion uses lowercase: ``family``, ``deaf``, ``coffee``.
  * Hyphenated English glosses (``THANK-YOU``) often map to concatenated
    dataset glosses (``THANKYOU`` / ``thankyou``).

This module owns the canonical alias-expansion ordering used by both
``scripts/curate_vocab.py`` (for matching cache vocab.json) and the data
loaders (for matching dataset-native gloss lists during extraction).
"""

from __future__ import annotations


# Maximum ASL-LEX numeric variant suffix to try (DEAF1, DEAF2, ..., DEAF<N>).
# ASL-LEX rarely goes above 5 in practice; cap at 9 for safety.
MAX_VARIANT_SUFFIX = 9


def expand_aliases(label: str) -> list[str]:
    """Return an ordered alias list for a canonical English label.

    Order matters: matches earlier in the list are preferred. We rank by
    (a) closer-to-canonical first, (b) lower-numbered variant first, (c)
    upper-case before lower-case (ASL Citizen uses upper-case and is the
    larger primary dataset).

    Whitespace handling: Kaggle ISLR uses lowercase with spaces or no
    separator at all (``"thank you"`` and ``"thankyou"`` are both valid; the
    map ships ``"thankyou"`` for some signs and ``"french fries"`` for others).
    We canonicalize by collapsing whitespace and producing both the spaceless
    and underscore-joined forms so the same alias list matches WLASL
    (``"thank you"``), ASL Citizen (``"THANKS"``), and Kaggle ISLR
    (``"thankyou"``).
    """
    seen: set[str] = set()
    out: list[str] = []

    def add(s: str):
        if s and s not in seen:
            seen.add(s)
            out.append(s)

    plain = label.strip()
    # First normalize internal whitespace: "thank  you" -> "thank you" so the
    # space/no-space derivations are stable.
    plain = " ".join(plain.split())
    # All three of {-, _, space} are normalized as inter-word separators so
    # spellings derive from each other regardless of which separator the input
    # used:
    #   no_sep    -> "THANKYOU"   (concatenated; ASL Citizen / Kaggle ISLR style)
    #   underscore-> "THANK_YOU"  (safe-filename style)
    #   spaced    -> "THANK YOU"  (WLASL2000 style)
    no_sep = plain.replace("-", "").replace(" ", "").replace("_", "")
    underscore = plain.replace("-", "_").replace(" ", "_")
    spaced = plain.replace("-", " ").replace("_", " ")
    spaced = " ".join(spaced.split())  # collapse any runs

    # Tier 1: exact, with case variants.
    for form in (plain, plain.upper(), plain.lower()):
        add(form)
    # Tier 2: separator-stripped (no hyphen, no space), with case variants.
    for form in (no_sep, no_sep.upper(), no_sep.lower()):
        add(form)
    # Tier 3: separator-as-underscore, with case variants.
    for form in (underscore, underscore.upper(), underscore.lower()):
        add(form)
    # Tier 4: separator-as-space (WLASL2000 spelling: "thank you", "french fries").
    for form in (spaced, spaced.upper(), spaced.lower()):
        add(form)
    # Tier 5: ASL-LEX numeric variant suffixes appended to each spelling,
    # lower numbers first (DEAF1 before DEAF2, ...).
    spellings = (plain, plain.upper(), plain.lower(),
                 no_sep, no_sep.upper(), no_sep.lower(),
                 underscore, underscore.upper(), underscore.lower(),
                 spaced, spaced.upper(), spaced.lower())
    for n in range(1, MAX_VARIANT_SUFFIX + 1):
        for sp in spellings:
            add(f"{sp}{n}")

    return out


def resolve_against_vocab(label: str, vocab: set[str] | list[str]
                          ) -> str | None:
    """Return the first alias of ``label`` that exists in ``vocab``, or None.

    ``vocab`` may be a set (fast) or a list (linear); we coerce to set for
    O(1) lookup.
    """
    vocab_set = set(vocab) if not isinstance(vocab, set) else vocab
    for alias in expand_aliases(label):
        if alias in vocab_set:
            return alias
    return None
