# Prompt Tester Service

Standalone Next.js app for testing and comparing LLM prompt strategies against SignChat ASL-token reconstruction fixtures.

## Quick start

```bash
cp .env.example .env
# add your OPENROUTER_API_KEY
npm install
npm run dev      # starts on http://localhost:3010
```

## What it does

- Loads all OpenRouter models into a searchable picker
- 5 named prompt strategies (A–E) covering:
  - A. Ground-truth stripped — honest LLM baseline, no cheat sheet
  - B. Noisy multi-turn — top-K classifier output + conversation history
  - C. Lean fast — narrowed per-turn dictionary, minimal tokens
  - D. All combined — every signal available
  - E. Lean options — top-K only, per-turn translations
- 43 scripted ASL turns across 11 topical suites (greeting, family, feelings, body, home, food-drink, clothing, weather, animals, daily-routine, goodbye) + off-script + ambiguous-context synthetic suites
- 9 noise variants per turn = 387 test cases
- **Run compare**: sends all selected strategies in parallel, shows scored result cards
- **Run all in suite**: sweeps every case with 25 concurrent workers
- Export results to JSON

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | Yes | OpenRouter API key |
| `OPENROUTER_APP_URL` | No | Sent as HTTP-Referer to OpenRouter |
| `OPENROUTER_APP_NAME` | No | Sent as X-Title to OpenRouter |
| `OPENROUTER_EMBEDDINGS` | No | Remote embedding similarity is on by default; set to `0` to disable |
| `OPENROUTER_EMBEDDING_MODEL` | No | Embedding model slug (default: openai/text-embedding-3-large) |
| `OPENROUTER_JUDGE_MODEL` | No | Judge model for naturalness scoring (default: `openai/gpt-5.4-mini`). Runs at `temperature: 0` with `seed: 42` so identical inputs always return identical scores. Judge runs by default; opt out per request with `?judge=0`. When the judge is unavailable, `composite` is `null`. |

## Scoring axes

Each run result includes:
- `composite` = 0.70×naturalness + 0.10×sentenceExact + 0.05×embeddingSimilarity + 0.05×rouge1Recall + 0.05×signUsageRate + 0.05×jsonValid — the LLM judge is the boss; the rest is a 0.30 sanity tax. `composite` is `null` when the judge is unavailable.
- `naturalness` — GPT-5.4-mini judge scores 1–5 against a naturalness rubric, normalized to [0, 1]. The judge sees only the hearing user's last line and the reconstructed sentence — never the locked-script ground truth — so it grades on merit, not deviation from a script.
- `sentenceExact` — normalized exact match against the locked-script ground truth
- `embeddingSimilarity` — remote OpenRouter embedding cosine (default model: `openai/text-embedding-3-large`); 0 when disabled or the call fails
- `rouge1Recall` — fraction of expected tokens present in the actual sentence
- `signUsageRate` — fraction of recognized ASL tokens the model claimed to have used
- `confidenceReported` — diagnostic only (high/medium/low → 1.0/0.5/0.0)
- `latencyMs`, `costUsd`

## Ports

Dev server runs on **3010** by default to avoid conflicts with other local services.
