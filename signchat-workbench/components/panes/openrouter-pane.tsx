"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { useLatencyStats } from "@/lib/diagnostics/latency-markers";
import { useCredentials } from "@/lib/credentials/store";
import {
  fetchOpenRouterCatalog,
  reconstruct,
  type OpenRouterCatalogEntry,
  type Pricing,
  type ReconstructionResult,
} from "@/lib/openrouter/client";
import type { SignTokenTopK } from "@/lib/openrouter/prompt";

/**
 * Phase 3 — Browser-direct OpenRouter reconstruction pane.
 *
 * Drives the frozen lean-options prompt against any of the dropdown models
 * using the deaf-only session key minted in the Lobby. Catalog check on
 * mount surfaces stale model ids; result card breaks down latency, tokens,
 * estimated cost, and the parsed payload. Phase 6 will wire this directly
 * into the live MediaPipe + ONNX classifier output instead of the canned
 * fixture picker, but the call shape stays identical.
 */

interface ModelOption {
  id: string;
  label: string;
  /** Short editorial note from prompt-tester-service/charts/RESULTS.md. */
  note: string;
}

const MODEL_OPTIONS: ReadonlyArray<ModelOption> = [
  {
    id: "google/gemini-3.1-flash-lite-preview",
    label: "Gemini 3.1 Flash Lite (preview)",
    note: "Default — top composite 0.761 in the lean-options sweep.",
  },
  {
    id: "google/gemini-3-flash-preview",
    label: "Gemini 3 Flash (preview)",
    note: "ARCHITECTURE.md default — premium quality at ~4x cost.",
  },
  {
    id: "mistralai/mistral-small-2603",
    label: "Mistral Small (2603)",
    note: "Best value — 0.731 composite at 37% of Gemini's cost.",
  },
];

const DEFAULT_MODEL_ID = MODEL_OPTIONS[0]!.id;
const MODEL_STORAGE_KEY = "signchat:model-id";

interface CannedFixture {
  turnId: string;
  hearingTranscript: string;
  tokens: string[];
  expected: string;
}

const CANNED_FIXTURES: ReadonlyArray<CannedFixture> = [
  {
    turnId: "turn_02",
    hearingTranscript: "How are you doing today?",
    tokens: ["FINE", "THANKYOU"],
    expected: "I'm fine, thank you.",
  },
  {
    turnId: "turn_05",
    hearingTranscript: "Do you have any brothers?",
    tokens: ["HAVE", "BROTHER"],
    expected: "I have a brother.",
  },
  {
    turnId: "turn_10",
    hearingTranscript: "How are you feeling right now?",
    tokens: ["HAPPY"],
    expected: "I'm happy.",
  },
  {
    turnId: "turn_13",
    hearingTranscript: "Are you hungry yet?",
    tokens: ["YES", "HUNGRY", "THIRSTY"],
    expected: "Yes, I'm hungry and thirsty.",
  },
  {
    turnId: "turn_22",
    hearingTranscript: "Do you want a drink?",
    tokens: ["YES", "WATER", "PLEASE"],
    expected: "Yes, water please.",
  },
  {
    turnId: "turn_23",
    hearingTranscript: "What sounds good for lunch?",
    tokens: ["PIZZA"],
    expected: "Pizza.",
  },
  {
    turnId: "turn_26",
    hearingTranscript: "What color is your shirt?",
    tokens: ["BLUE"],
    expected: "It's blue.",
  },
  {
    turnId: "turn_29",
    hearingTranscript: "How's the weather where you are?",
    tokens: ["SUN", "HOT"],
    expected: "It's sunny and hot.",
  },
  {
    turnId: "turn_33",
    hearingTranscript: "Do you have any pets?",
    tokens: ["YES", "DOG", "CAT"],
    expected: "Yes, a dog and a cat.",
  },
  {
    turnId: "turn_42",
    hearingTranscript: "Should we talk again tomorrow at the same time?",
    tokens: ["YES", "TOMORROW", "SAME", "TIME"],
    expected: "Yes, tomorrow same time.",
  },
];

// Neighbour pool for the optional synthetic top-K alternatives. Drawn from
// the high-frequency / commonly-confused PopSign labels so the alternatives
// look plausible to the model rather than random vocabulary noise.
const NEIGHBOUR_POOL: ReadonlyArray<string> = [
  "YES",
  "NO",
  "PLEASE",
  "THANKYOU",
  "FINE",
  "SAME",
  "TIME",
  "HAPPY",
  "MAD",
  "WATER",
  "MILK",
  "ICECREAM",
  "PIZZA",
  "DOG",
  "CAT",
  "MOM",
  "DAD",
  "HOME",
];

const CONFIDENCE_PALETTE: Record<"high" | "medium" | "low", string> = {
  high: "border-emerald-500/40 bg-emerald-500/10 text-emerald-200",
  medium: "border-amber-500/40 bg-amber-500/10 text-amber-200",
  low: "border-rose-500/40 bg-rose-500/10 text-rose-200",
};

interface HistoryEntry {
  id: number;
  ts: number;
  modelId: string;
  fixture: string;
  result: ReconstructionResult;
}

export function OpenRouterPane() {
  const credentials = useCredentials();
  const reconstructLatency = useLatencyStats("openrouter.reconstruct");

  const [modelId, setModelId] = useState<string>(() => {
    if (typeof window === "undefined") return DEFAULT_MODEL_ID;
    const saved = window.localStorage.getItem(MODEL_STORAGE_KEY);
    if (saved && MODEL_OPTIONS.some((option) => option.id === saved)) {
      return saved;
    }
    return DEFAULT_MODEL_ID;
  });
  const [fixtureIndex, setFixtureIndex] = useState<number>(5); // PIZZA
  const [hearingTranscript, setHearingTranscript] = useState<string>(
    CANNED_FIXTURES[5]!.hearingTranscript,
  );
  const [tokensText, setTokensText] = useState<string>(
    CANNED_FIXTURES[5]!.tokens.join(" "),
  );
  const [includeAlternatives, setIncludeAlternatives] = useState<boolean>(true);

  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<ReconstructionResult | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [showRaw, setShowRaw] = useState<boolean>(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState<boolean>(false);

  const [catalog, setCatalog] = useState<OpenRouterCatalogEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const historyIdRef = useRef<number>(1);

  useEffect(() => {
    LogBus.debug("openrouter", "openrouter pane mounted");
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(MODEL_STORAGE_KEY, modelId);
  }, [modelId]);

  // Catalog check — public endpoint, no auth needed (per ARCHITECTURE.md §5.7).
  useEffect(() => {
    const ac = new AbortController();
    fetchOpenRouterCatalog(ac.signal)
      .then((entries) => {
        setCatalog(entries);
        const ids = new Set(entries.map((e) => e.id));
        const missing = MODEL_OPTIONS.filter((o) => !ids.has(o.id)).map(
          (o) => o.id,
        );
        if (missing.length > 0) {
          LogBus.warn("openrouter", "model ids missing from catalog", {
            missing,
          });
        }
      })
      .catch((err) => {
        if ((err as { name?: string }).name === "AbortError") return;
        setCatalogError(errMsg(err));
        LogBus.warn("openrouter", "catalog fetch failed", {
          error: errMsg(err),
        });
      });
    return () => ac.abort();
  }, []);

  const pricingForModel = useMemo<Pricing | null>(() => {
    if (!catalog) return null;
    const entry = catalog.find((e) => e.id === modelId);
    return entry?.pricing ?? null;
  }, [catalog, modelId]);

  const isHearingRole = credentials.context?.role === "hearing";
  const hasKey = Boolean(credentials.openrouter?.apiKey);
  const modelUnavailable = useMemo(() => {
    if (!catalog) return false;
    return !catalog.some((e) => e.id === modelId);
  }, [catalog, modelId]);

  const selectedFixture =
    fixtureIndex >= 0 && fixtureIndex < CANNED_FIXTURES.length
      ? CANNED_FIXTURES[fixtureIndex]!
      : null;

  const onPickFixture = (idx: number) => {
    setFixtureIndex(idx);
    if (idx >= 0 && idx < CANNED_FIXTURES.length) {
      const fixture = CANNED_FIXTURES[idx]!;
      setHearingTranscript(fixture.hearingTranscript);
      setTokensText(fixture.tokens.join(" "));
    }
  };

  const tokens = useMemo(() => parseTokens(tokensText), [tokensText]);

  const topK = useMemo<SignTokenTopK[]>(() => {
    return tokens.map((word, i) => {
      const baseScore = 0.85 - i * 0.02;
      const alternatives = includeAlternatives
        ? buildAlternatives(word)
        : [];
      return {
        word,
        score: baseScore,
        alternatives,
      };
    });
  }, [tokens, includeAlternatives]);

  const canRun =
    hasKey &&
    !isHearingRole &&
    tokens.length > 0 &&
    !busy &&
    !modelUnavailable;

  const onRun = async () => {
    if (!credentials.openrouter) return;
    setBusy(true);
    setError(null);
    try {
      const result = await reconstruct({
        apiKey: credentials.openrouter.apiKey,
        modelId,
        hearingTranscript,
        topK,
        pricing: pricingForModel,
      });
      setLatest(result);
      setHistory((prev) => {
        const entry: HistoryEntry = {
          id: historyIdRef.current++,
          ts: Date.now(),
          modelId,
          fixture: selectedFixture?.turnId ?? "(custom)",
          result,
        };
        return [entry, ...prev].slice(0, 10);
      });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
        <div className="mb-3 flex items-baseline justify-between">
          <div className="flex items-baseline gap-3">
            <h2 className="text-xl font-semibold text-slate-100">
              OpenRouter reconstruction
            </h2>
            <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-emerald-300">
              Phase 3 — live
            </span>
            {hasKey ? (
              <span className="rounded-full border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-sky-200">
                key ready
              </span>
            ) : (
              <span className="rounded-full border border-slate-600 bg-slate-700/30 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-300">
                no key
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500">
            {reconstructLatency ? (
              <span>
                p50 {Math.round(reconstructLatency.p50)}ms / p95{" "}
                {Math.round(reconstructLatency.p95)}ms ({reconstructLatency.count})
              </span>
            ) : null}
          </div>
        </div>
        {isHearingRole ? (
          <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            Reconstruction is deaf-only (ARCHITECTURE.md §10.2). Switch role to
            <code className="mx-1 rounded bg-slate-800 px-1.5 py-0.5">deaf</code>
            in the Lobby and re-mint to use this pane.
          </p>
        ) : !hasKey ? (
          <p className="mb-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-200">
            No OpenRouter session key in the credentials store. Mint one in the
            Lobby first.
          </p>
        ) : (
          <p className="mb-2 text-sm text-slate-400">
            Browser POSTs straight to{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              openrouter.ai/api/v1/chat/completions
            </code>{" "}
            with the frozen{" "}
            <code className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              lean-options
            </code>{" "}
            prompt. Vercel is not on this hop.
          </p>
        )}
        {catalogError ? (
          <p className="text-[11px] text-amber-300">
            Catalog fetch failed: {catalogError}
          </p>
        ) : null}
      </header>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-400" htmlFor="or-model">
              model
            </label>
            <select
              id="or-model"
              value={modelId}
              onChange={(e) => setModelId(e.target.value)}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-100"
            >
              {MODEL_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2 text-[11px] text-slate-500">
              <span>
                {MODEL_OPTIONS.find((o) => o.id === modelId)?.note}
              </span>
              {modelUnavailable ? (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-200">
                  model unavailable in catalog
                </span>
              ) : null}
            </div>
          </div>
          <div className="space-y-1">
            <label className="block text-xs font-medium text-slate-400" htmlFor="or-fixture">
              canned fixture
            </label>
            <select
              id="or-fixture"
              value={fixtureIndex}
              onChange={(e) => onPickFixture(Number(e.target.value))}
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-xs text-slate-100"
            >
              {CANNED_FIXTURES.map((fixture, i) => (
                <option key={fixture.turnId} value={i}>
                  {fixture.turnId} — {fixture.tokens.join(" ")} → {fixture.expected}
                </option>
              ))}
              <option value={-1}>(custom)</option>
            </select>
            <p className="text-[11px] text-slate-500">
              Pre-fills hearing + tokens. Editing either decouples from the
              fixture preset; the call uses whatever is in the inputs below.
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-400"
              htmlFor="or-hearing"
            >
              hearing transcript (optional)
            </label>
            <input
              id="or-hearing"
              type="text"
              value={hearingTranscript}
              onChange={(e) => setHearingTranscript(e.target.value)}
              placeholder="(none)"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500"
            />
          </div>
          <div className="space-y-1">
            <label
              className="block text-xs font-medium text-slate-400"
              htmlFor="or-tokens"
            >
              recognized signs (UPPERCASE, space-separated)
            </label>
            <input
              id="or-tokens"
              type="text"
              value={tokensText}
              onChange={(e) => setTokensText(e.target.value)}
              placeholder="PIZZA"
              className="w-full rounded-md border border-slate-700 bg-slate-900 px-2 py-1.5 font-mono text-sm text-slate-100 outline-none focus:border-sky-500"
            />
            <p className="text-[11px] text-slate-500">
              Phase 6 will replace this with live classifier top-K from the
              Sign capture pane.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={includeAlternatives}
                onChange={(e) => setIncludeAlternatives(e.target.checked)}
                className="h-3.5 w-3.5"
              />
              include synthetic top-2 alternatives (lean-options branch)
            </label>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void onRun()}
            disabled={!canRun}
            className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-sm text-emerald-200 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Running…" : "Run reconstruct"}
          </button>
          <button
            type="button"
            onClick={() => setShowSystemPrompt((v) => !v)}
            className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
          >
            {showSystemPrompt ? "hide" : "show"} system prompt
          </button>
          {error ? (
            <span className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-xs text-rose-200">
              {error}
            </span>
          ) : null}
        </div>
        {showSystemPrompt && latest ? (
          <pre className="mt-3 max-h-40 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
            {latest.systemPrompt}
            {"\n\n--- user ---\n"}
            {latest.userPrompt}
          </pre>
        ) : null}
      </div>

      {latest ? <ResultCard result={latest} showRaw={showRaw} setShowRaw={setShowRaw} /> : null}

      <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-slate-100">
            History{" "}
            <span className="ml-1 text-[11px] font-normal text-slate-500">
              {history.length}/10
            </span>
          </h3>
          {history.length > 0 ? (
            <button
              type="button"
              onClick={() => setHistory([])}
              className="rounded border border-slate-600 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
            >
              Clear
            </button>
          ) : null}
        </div>
        {history.length === 0 ? (
          <div className="rounded-md border border-dashed border-slate-700 p-4 text-center text-xs text-slate-500">
            No runs yet. Pick a fixture, hit Run reconstruct.
          </div>
        ) : (
          <ul className="space-y-1.5">
            {history.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start gap-2 rounded-md border border-slate-800 bg-slate-900/40 px-2 py-1.5 text-xs"
              >
                <span className="w-16 shrink-0 truncate font-mono text-slate-400">
                  {entry.fixture}
                </span>
                <span
                  className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${CONFIDENCE_PALETTE[entry.result.parsed.confidence]}`}
                >
                  {entry.result.parsed.confidence}
                </span>
                <span className="grow truncate text-slate-100">
                  {entry.result.parsed.sentence}
                </span>
                <span className="shrink-0 text-[10px] tabular-nums text-slate-500">
                  {entry.result.latencyMs}ms
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function ResultCard({
  result,
  showRaw,
  setShowRaw,
}: {
  result: ReconstructionResult;
  showRaw: boolean;
  setShowRaw: (v: boolean) => void;
}) {
  const { parsed, latencyMs, usage, costUsd, modelId } = result;
  return (
    <div className="rounded-xl border border-slate-700 bg-slate-900/50 p-6">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-100">Result</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${CONFIDENCE_PALETTE[parsed.confidence]}`}
        >
          {parsed.confidence}
        </span>
        {parsed.needsClarification ? (
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-amber-200">
            needs clarification
          </span>
        ) : null}
        {parsed.matchedScriptId ? (
          <span className="rounded-full border border-slate-600 bg-slate-800/60 px-2 py-0.5 text-[11px] font-mono text-slate-300">
            {parsed.matchedScriptId}
          </span>
        ) : null}
      </div>
      <p className="mb-3 text-xl font-semibold text-slate-50">
        {parsed.sentence}
      </p>
      {parsed.usedSigns.length > 0 ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5">
          {parsed.usedSigns.map((sign) => (
            <span
              key={sign}
              className="rounded-full border border-fuchsia-500/40 bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[10px] tracking-wide text-fuchsia-200"
            >
              {sign}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-slate-400">
        <span>
          model:{" "}
          <code className="text-slate-200">{modelId}</code>
        </span>
        <span>
          latency: <span className="tabular-nums text-slate-200">{latencyMs}ms</span>
        </span>
        {usage?.inputTokens !== undefined ? (
          <span>
            in:{" "}
            <span className="tabular-nums text-slate-200">
              {usage.inputTokens}
            </span>{" "}
            tok
          </span>
        ) : null}
        {usage?.outputTokens !== undefined ? (
          <span>
            out:{" "}
            <span className="tabular-nums text-slate-200">
              {usage.outputTokens}
            </span>{" "}
            tok
          </span>
        ) : null}
        {costUsd !== undefined ? (
          <span>
            cost:{" "}
            <span className="tabular-nums text-slate-200">
              ${costUsd.toFixed(6)}
            </span>
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setShowRaw(!showRaw)}
          className="ml-auto rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800"
        >
          {showRaw ? "hide raw" : "show raw"}
        </button>
      </div>
      {showRaw ? (
        <pre className="mt-3 max-h-48 overflow-auto rounded-md border border-slate-800 bg-slate-950 p-3 text-[11px] text-slate-300">
          {result.raw}
        </pre>
      ) : null}
    </div>
  );
}

function parseTokens(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((t) => t.trim().toUpperCase())
    .filter((t) => t.length > 0);
}

function buildAlternatives(
  word: string,
): Array<{ word: string; score: number }> {
  const candidates = NEIGHBOUR_POOL.filter((n) => n !== word);
  // Deterministic per-word picks so the prompt is stable across runs.
  const seed = simpleHash(word);
  const a = candidates[seed % candidates.length] ?? "YES";
  const b =
    candidates[(seed * 31 + 7) % candidates.length] === a
      ? candidates[((seed * 31 + 7) % candidates.length + 1) % candidates.length] ?? "NO"
      : candidates[(seed * 31 + 7) % candidates.length] ?? "NO";
  return [
    { word: a, score: 0.42 },
    { word: b, score: 0.31 },
  ];
}

function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "unknown error";
}
