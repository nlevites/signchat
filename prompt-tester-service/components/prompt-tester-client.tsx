"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowsClockwise,
  Brain,
  DownloadSimple,
  Play,
  Stack,
  StopCircle,
  X,
} from "@phosphor-icons/react/dist/ssr";
import { composeUserPrompt } from "@/lib/compose";
import {
  ALL_CASES,
  CASE_SUITE_IDS,
  CASE_SUITES,
} from "@/lib/fixtures";
import { STRATEGIES, STRATEGY_IDS, getStrategy } from "@/lib/strategies";
import type { PromptStrategyId } from "@/lib/strategies";
import type {
  ExpectedResult,
  OpenRouterModel,
  PromptTestCase,
  PromptTesterCompareRequest,
  PromptTesterCompareResponse,
  PromptTesterRunResponse,
  ScriptTopic,
} from "@/lib/types";
import { SCRIPT_TOPICS } from "@/lib/types";

// ── Tailwind class helpers ────────────────────────────────────────────────────

const CLS = {
  btnPrimary:
    "inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-700 disabled:opacity-40 disabled:pointer-events-none",
  btnSecondary:
    "inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3.5 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-40 disabled:pointer-events-none",
  btnDanger:
    "inline-flex items-center gap-2 rounded-lg bg-red-600 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-40 disabled:pointer-events-none",
  btnGhost:
    "inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-40 disabled:pointer-events-none",
  card: "rounded-xl border border-gray-200 bg-white p-5 shadow-sm",
  input:
    "h-9 w-full rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 placeholder:text-gray-400 transition-colors hover:border-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20",
  select:
    "h-9 w-full appearance-none rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 transition-colors hover:border-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 cursor-pointer",
  label: "block text-xs font-medium text-gray-600",
  sectionTitle: "text-sm font-semibold text-gray-900",
  caption: "mt-0.5 text-xs text-gray-500",
  pillActive:
    "inline-flex items-center gap-1 rounded-full bg-indigo-100 px-2.5 py-1 text-xs font-medium text-indigo-700 transition-colors cursor-pointer",
  pillInactive:
    "inline-flex items-center gap-1 rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:bg-indigo-100 hover:text-indigo-700 cursor-pointer",
  muted: "text-xs text-gray-500",
  detailBox:
    "rounded-lg border border-gray-200 overflow-hidden",
  detailSummary:
    "cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50",
  detailBody:
    "max-h-[300px] overflow-auto border-t border-gray-200 bg-gray-50 p-3 text-xs leading-5 text-gray-600 whitespace-pre-wrap",
};

// ── Types ─────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL_ID = "openai/gpt-4o-mini";
type LibrarySelection = "default" | PromptStrategyId;

interface CompareState {
  results: readonly PromptTesterRunResponse[];
  errors: readonly { strategyId: string; error: string }[];
}
interface CompiledStrategyPrompt {
  strategy: (typeof STRATEGIES)[number];
  systemPrompt: string;
  userTemplate: string;
  compiledUser: string;
}
interface SweepCaseResult {
  caseId: string;
  topic: ScriptTopic;
  suite: string;
  expected: ExpectedResult;
  results: readonly PromptTesterRunResponse[];
  errors: readonly { strategyId: string; error: string }[];
}
interface SweepState {
  suiteId: string;
  total: number;
  results: readonly SweepCaseResult[];
}
interface SweepAggregate {
  strategyId: string;
  label: string;
  count: number;
  avgComposite: number;
  exactRate: number;
  avgRouge1: number;
  avgSignUsage: number;
  avgLatencyMs: number;
  totalCost: number;
}

const SWEEP_CONCURRENCY = 4;

// ── Main component ────────────────────────────────────────────────────────────

export function PromptTesterClient({
  initialModels,
  initialModelLoadError,
}: {
  initialModels: readonly OpenRouterModel[];
  initialModelLoadError: string | null;
}) {
  const [models, setModels] = useState<OpenRouterModel[]>([...initialModels]);
  const [modelLoadError, setModelLoadError] = useState<string | null>(initialModelLoadError);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [suiteId, setSuiteId] = useState("clean");
  const [caseId, setCaseId] = useState("turn_01/clean");
  const [systemSelection, setSystemSelection] = useState<LibrarySelection>("default");
  const [userTemplateSelection, setUserTemplateSelection] = useState<LibrarySelection>("default");
  const [selectedStrategies, setSelectedStrategies] = useState<ReadonlySet<PromptStrategyId>>(
    () => new Set(STRATEGY_IDS),
  );
  const [compareResult, setCompareResult] = useState<CompareState | null>(null);
  const [sweepState, setSweepState] = useState<SweepState | null>(null);
  const [sweepAbort, setSweepAbort] = useState<AbortController | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isSweeping, setIsSweeping] = useState(false);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  const casesForSuite = useMemo(() => CASE_SUITES[suiteId] ?? [], [suiteId]);
  const casesByTopic = useMemo(() => groupCasesByTopic(casesForSuite), [casesForSuite]);
  const selectedCase = useMemo(
    () => ALL_CASES.find((tc) => tc.id === caseId) ?? ALL_CASES[0],
    [caseId],
  );
  const selectedModel = useMemo(
    () => models.find((m) => m.id === modelId),
    [modelId, models],
  );

  const loadModels = useCallback(async () => {
    setIsLoadingModels(true);
    setModelLoadError(null);
    try {
      const response = await fetch("/api/prompt-tester/models", { cache: "no-store" });
      const body = (await response.json()) as { models?: OpenRouterModel[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Model fetch failed");
      setModels(body.models ?? []);
    } catch (error) {
      setModelLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingModels(false);
    }
  }, []);

  const onSuiteChange = (nextId: string) => {
    setSuiteId(nextId);
    const firstCase = CASE_SUITES[nextId]?.[0];
    if (firstCase) setCaseId(firstCase.id);
  };

  const onTopicJump = (topic: ScriptTopic) => {
    const firstCase = casesByTopic.get(topic)?.[0];
    if (firstCase) setCaseId(firstCase.id);
  };

  const onNextCase = () => {
    if (casesForSuite.length === 0) return;
    const currentIndex = casesForSuite.findIndex((tc) => tc.id === caseId);
    const next = casesForSuite[(currentIndex + 1) % casesForSuite.length];
    if (next) setCaseId(next.id);
  };

  const systemPromptOverride = useMemo<string | null>(() => {
    if (systemSelection === "default") return null;
    return getStrategy(systemSelection)?.systemPrompt ?? null;
  }, [systemSelection]);

  const userPromptTemplateOverride = useMemo<string | null>(() => {
    if (userTemplateSelection === "default") return null;
    return getStrategy(userTemplateSelection)?.userTemplate ?? null;
  }, [userTemplateSelection]);

  const compiledStrategyPrompts = useMemo<CompiledStrategyPrompt[]>(() => {
    if (!selectedCase) return [];
    return STRATEGIES.filter((s) => selectedStrategies.has(s.id)).map((strategy) => {
      const systemPrompt = systemPromptOverride ?? strategy.systemPrompt;
      const userTemplate = userPromptTemplateOverride ?? strategy.userTemplate;
      return { strategy, systemPrompt, userTemplate, compiledUser: composeUserPrompt(userTemplate, selectedCase) };
    });
  }, [selectedCase, selectedStrategies, systemPromptOverride, userPromptTemplateOverride]);

  const toggleStrategy = (id: PromptStrategyId) => {
    setSelectedStrategies((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  };

  const buildCompareBodyBase = useCallback((): Omit<PromptTesterCompareRequest, "caseId"> => ({
    modelId,
    strategyIds: STRATEGY_IDS.filter((id) => selectedStrategies.has(id)),
    ...(selectedModel ? { pricing: { prompt: selectedModel.promptPrice, completion: selectedModel.completionPrice } } : {}),
    ...(systemPromptOverride ? { systemPromptOverride } : {}),
    ...(userPromptTemplateOverride ? { userPromptTemplateOverride } : {}),
  }), [modelId, selectedModel, selectedStrategies, systemPromptOverride, userPromptTemplateOverride]);

  const sendCompare = async () => {
    setPreviewOpen(false);
    setIsRunning(true);
    setRunError(null);
    setCompareResult(null);
    setSweepState(null);
    try {
      const body: PromptTesterCompareRequest = { ...buildCompareBodyBase(), caseId };
      const response = await fetch("/api/prompt-tester/compare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await response.json()) as (PromptTesterCompareResponse & { errors?: { strategyId: string; error: string }[] }) | { error?: string };
      if (!response.ok) throw new Error("error" in json && typeof json.error === "string" ? json.error : "Compare run failed");
      const compare = json as PromptTesterCompareResponse & { errors?: { strategyId: string; error: string }[] };
      setCompareResult({ results: compare.results, errors: compare.errors ?? [] });
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRunning(false);
    }
  };

  const runSweep = async () => {
    if (casesForSuite.length === 0) return;
    const cases = [...casesForSuite];
    const abort = new AbortController();
    setSweepAbort(abort);
    setIsSweeping(true);
    setRunError(null);
    setCompareResult(null);
    setSweepState({ suiteId, total: cases.length, results: [] });
    const baseBody = buildCompareBodyBase();
    let nextIndex = 0;
    const errors: string[] = [];

    const runOne = async (testCase: PromptTestCase) => {
      try {
        const response = await fetch("/api/prompt-tester/compare", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...baseBody, caseId: testCase.id }),
          signal: abort.signal,
        });
        const json = (await response.json()) as (PromptTesterCompareResponse & { errors?: { strategyId: string; error: string }[] }) | { error?: string };
        if (!response.ok) throw new Error("error" in json && typeof json.error === "string" ? json.error : `Compare ${testCase.id} failed`);
        const compare = json as PromptTesterCompareResponse & { errors?: { strategyId: string; error: string }[] };
        setSweepState((prev) => prev && prev.suiteId === suiteId
          ? { ...prev, results: [...prev.results, { caseId: testCase.id, topic: testCase.topic, suite: testCase.suite, expected: testCase.expected, results: compare.results, errors: compare.errors ?? [] }] }
          : prev);
      } catch (error) {
        if (abort.signal.aborted) return;
        errors.push(`${testCase.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };

    const worker = async () => {
      while (!abort.signal.aborted) {
        const index = nextIndex;
      nextIndex += 1;
        if (index >= cases.length) return;
        const testCase = cases[index];
        if (!testCase) return;
        await runOne(testCase);
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, cases.length) }, () => worker()));
      if (errors.length > 0 && !abort.signal.aborted) setRunError(errors.slice(0, 3).join("\n"));
    } finally {
      setIsSweeping(false);
      setSweepAbort(null);
    }
  };

  const cancelSweep = () => sweepAbort?.abort();

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      {/* Header */}
      <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/90 px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-screen-2xl flex-col gap-3">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 text-[15px] font-semibold text-gray-900">
                <Brain size={18} weight="bold" />
                Prompt Tester
              </div>
              <span className="hidden text-xs text-gray-400 sm:block">
                OpenRouter model picker · SignChat ASL reconstruction strategies
              </span>
            </div>
            <div className="flex items-center gap-2">
              {isSweeping ? (
                <button type="button" onClick={cancelSweep} className={CLS.btnDanger}>
                  <StopCircle size={14} weight="bold" />
                  Cancel sweep
                </button>
              ) : null}
              <button
                type="button"
                onClick={runSweep}
                disabled={isRunning || isSweeping || casesForSuite.length === 0 || selectedStrategies.size === 0}
                className={CLS.btnSecondary}
              >
                <Stack size={14} weight="bold" />
                {isSweeping
                  ? `Sweeping ${sweepState?.results.length ?? 0}/${sweepState?.total ?? 0}...`
                  : `Run all in ${suiteId} (${casesForSuite.length})`}
              </button>
              <button
                type="button"
                onClick={() => { if (selectedCase) { setRunError(null); setPreviewOpen(true); } }}
                disabled={isRunning || isSweeping || !selectedCase || selectedStrategies.size === 0}
                className={CLS.btnPrimary}
              >
                <Play size={15} weight="bold" />
                {isRunning ? "Running..." : "Run compare"}
              </button>
            </div>
          </div>
          {/* Strategy pills — single scrollable row */}
          <div
            className="flex items-center gap-2 overflow-x-auto pb-0.5"
            aria-label="Selected strategies"
          >
            <span className="shrink-0 text-[10px] text-gray-400">Strategies:</span>
            {STRATEGIES.map((strategy) => {
              const active = selectedStrategies.has(strategy.id);
              return (
                <button
                  key={strategy.id}
                  type="button"
                  onClick={() => toggleStrategy(strategy.id)}
                  aria-pressed={active}
                  className={"shrink-0 " + (active ? CLS.pillActive : CLS.pillInactive)}
                  style={{ fontSize: "10px" }}
                >
                  {strategy.label}
                </button>
              );
            })}
            <button type="button" onClick={() => setSelectedStrategies(new Set(STRATEGY_IDS))} className={CLS.btnGhost + " shrink-0"} style={{ fontSize: "10px" }}>All</button>
            <button type="button" onClick={() => setSelectedStrategies(new Set())} className={CLS.btnGhost + " shrink-0"} style={{ fontSize: "10px" }}>None</button>
            {selectedStrategies.size === 0 ? <span className="shrink-0 text-[10px] text-red-600">Select at least one.</span> : null}
          </div>
        </div>
      </header>

      {/* Two-phase layout: sidebar + full-width results when results are present */}
      <main className="mx-auto max-w-screen-2xl px-6 py-5">
        {/* Config row — always visible */}
        <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
          {/* Left: Model + Fixture */}
          <section className="space-y-4">
            <div className={CLS.card + " space-y-4"}>
              <div>
                <p className={CLS.sectionTitle}>Model</p>
                <p className={CLS.caption}>Any OpenRouter model ID.</p>
              </div>
              <label className={CLS.label}>
                OpenRouter model
                <input
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  list="openrouter-models"
                  placeholder="openai/gpt-4o-mini"
                  className={CLS.input + " mt-1"}
                />
              </label>
              <datalist id="openrouter-models">
                {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </datalist>
              <div className="flex items-center justify-between gap-3 text-xs text-gray-500">
                <span>{isLoadingModels ? "Loading..." : `${models.length.toLocaleString()} models`}</span>
                <button type="button" onClick={loadModels} className={CLS.btnGhost}>
                  <ArrowsClockwise size={13} />
                  Refresh
                </button>
              </div>
              {modelLoadError ? <AlertBox tone="warn" message={modelLoadError} /> : null}
              {selectedModel ? (
                <div className="rounded-lg bg-gray-50 p-3 text-xs text-gray-600">
                  <div className="font-medium text-gray-800">{selectedModel.name}</div>
                  <div className="mt-1">Context: {selectedModel.contextLength?.toLocaleString() ?? "unknown"}</div>
                  <div>Prompt {selectedModel.promptPrice ?? "?"} · completion {selectedModel.completionPrice ?? "?"}</div>
                </div>
              ) : null}
            </div>

            <div className={CLS.card + " space-y-4"}>
              <div>
                <p className={CLS.sectionTitle}>Fixture</p>
                <p className={CLS.caption}>ASL-token stream to test.</p>
              </div>
              <label className={CLS.label}>
                Suite
                <select value={suiteId} onChange={(e) => onSuiteChange(e.target.value)} className={CLS.select + " mt-1"}>
                  {CASE_SUITE_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                </select>
              </label>
              <div>
                <div className="text-xs font-medium text-gray-600">Topics</div>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {SCRIPT_TOPICS.map((topic) => {
                    const cases = casesByTopic.get(topic);
                    if (!cases || cases.length === 0) return null;
                    const active = selectedCase?.topic === topic;
                    return (
                      <button key={topic} type="button" onClick={() => onTopicJump(topic)} aria-pressed={active}
                        className={active ? CLS.pillActive : CLS.pillInactive}>
                        {topic}
                        <span className="opacity-60">{cases.length}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
              <label className={CLS.label}>
                Case
                <select value={caseId} onChange={(e) => setCaseId(e.target.value)} className={CLS.select + " mt-1"}>
                  {SCRIPT_TOPICS.map((topic) => {
                    const cases = casesByTopic.get(topic);
                    if (!cases || cases.length === 0) return null;
                    return (
                      <optgroup key={topic} label={topic}>
                        {cases.map((tc) => <option key={tc.id} value={tc.id}>{tc.id} — {tc.expected.sentence}</option>)}
                      </optgroup>
                    );
                  })}
                </select>
              </label>
              <div className="flex items-center justify-between text-xs text-gray-500">
                <span>{casesForSuite.length} cases · {casesByTopic.size} topics</span>
                <button type="button" onClick={onNextCase} className={CLS.btnGhost}>
                  Next case <ArrowRight size={13} weight="bold" />
                </button>
              </div>
              {selectedCase ? <CasePreview testCase={selectedCase} /> : null}
            </div>
          </section>

          {/* Right of sidebar: Prompt selectors */}
          <section className="space-y-4">
            <div className={CLS.card + " space-y-3"}>
              <div>
                <p className={CLS.sectionTitle}>System prompt</p>
                <p className={CLS.caption}>Override every slot, or leave per-strategy.</p>
              </div>
              <select value={systemSelection} onChange={(e) => setSystemSelection(e.target.value as LibrarySelection)} className={CLS.select}>
                <option value="default">Strategy default (per-slot)</option>
                {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <PromptLibraryPreview selection={systemSelection} kind="system" />
            </div>
            <div className={CLS.card + " space-y-3"}>
              <div>
                <p className={CLS.sectionTitle}>User prompt template</p>
                <p className={CLS.caption}>Placeholders replaced from the selected fixture.</p>
              </div>
              <select value={userTemplateSelection} onChange={(e) => setUserTemplateSelection(e.target.value as LibrarySelection)} className={CLS.select}>
                <option value="default">Strategy default (per-slot)</option>
                {STRATEGIES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
              <PromptLibraryPreview selection={userTemplateSelection} kind="user" />
            </div>
          </section>
        </div>

        {/* Results — full width below the config row */}
        <div className="mt-4">
          <div className={CLS.card + " space-y-4"}>
            <div className="flex items-center justify-between">
              <div>
                <p className={CLS.sectionTitle}>Result</p>
                <p className={CLS.caption}>Exact, embedding, cost, latency — per strategy.</p>
              </div>
            </div>
            {runError ? <AlertBox tone="error" message={runError} /> : null}
            {sweepState ? (
              <SweepResultsPanel state={sweepState} isRunning={isSweeping} />
            ) : compareResult ? (
              <CompareResultPanel state={compareResult} />
            ) : (
              <EmptyResult isRunning={isRunning || isSweeping} />
            )}
          </div>
        </div>
      </main>

      {/* Preview modal */}
      <SimpleModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title="Preview compare run before sending"
        footer={
          <div className="flex gap-2">
            <button type="button" onClick={() => setPreviewOpen(false)} className={CLS.btnSecondary}>Cancel</button>
            <button type="button" onClick={sendCompare} className={CLS.btnPrimary}>
              <Play size={14} weight="bold" />
              Send {compiledStrategyPrompts.length} strategies
            </button>
          </div>
        }
      >
        <ComparePreview modelId={modelId} caseId={caseId} entries={compiledStrategyPrompts} />
      </SimpleModal>
    </div>
  );
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function groupCasesByTopic(cases: readonly PromptTestCase[]): ReadonlyMap<ScriptTopic, readonly PromptTestCase[]> {
  const buckets = new Map<ScriptTopic, PromptTestCase[]>();
  for (const tc of cases) {
    const bucket = buckets.get(tc.topic);
    if (bucket) bucket.push(tc);
    else buckets.set(tc.topic, [tc]);
  }
  return buckets;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function averageDefined(values: readonly (number | null | undefined)[]): number {
  const defined = values.filter((v): v is number => typeof v === "number");
  return average(defined);
}

function compareComposite(a: number | null, b: number | null): number {
  const av = a ?? -Infinity;
  const bv = b ?? -Infinity;
  return bv - av;
}

function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function confidenceLabel(value: number): string {
  if (value === 1) return "high";
  if (value === 0.5) return "medium";
  if (value === 0) return "low";
  return "?";
}

function formatCost(value: number | undefined): string {
  if (value === undefined) return "?";
  if (value === 0) return "$0";
  if (value < 0.001) return `$${value.toExponential(2)}`;
  return `$${value.toFixed(4)}`;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function sanitizeForFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-");
}

function exportTimestamp(): string {
  return sanitizeForFilename(new Date().toISOString().replace(/\.\d{3}Z$/, "Z"));
}

// ── UI components (no custom primitives) ─────────────────────────────────────

function AlertBox({ tone, message }: { tone: "error" | "warn"; message: string }) {
  const cls = tone === "error"
    ? "border-red-300 bg-red-50 text-red-700"
    : "border-amber-300 bg-amber-50 text-amber-800";
  return <div className={`rounded-lg border px-3 py-2 text-xs ${cls}`}>{message}</div>;
}

function CasePreview({ testCase }: { testCase: PromptTestCase }) {
  return (
    <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="uppercase tracking-wide text-gray-400">{testCase.suite}</span>
        <span className="rounded-full bg-white px-2 py-0.5 text-gray-600 border border-gray-200">{testCase.topic}</span>
      </div>
      <div><div className="font-medium text-gray-800">Recognized signs</div><div className="mt-0.5 font-mono text-gray-600">{testCase.recognizedSigns.map((s) => s.word).join(" ")}</div></div>
      <div><div className="font-medium text-gray-800">Hearing transcript</div><div className="mt-0.5 text-gray-600">{testCase.hearingTranscript.join(" ") || "(none)"}</div></div>
      <div><div className="font-medium text-gray-800">Expected</div><div className="mt-0.5 text-gray-600">{testCase.expected.sentence}</div></div>
      {testCase.notes ? <div className="text-gray-400">{testCase.notes}</div> : null}
    </div>
  );
}

function EmptyResult({ isRunning }: { isRunning: boolean }) {
  return (
    <p className="py-8 text-center text-sm text-gray-400">
      {isRunning ? "Waiting for OpenRouter..." : "Run compare to see strategies side-by-side."}
    </p>
  );
}

function PromptLibraryPreview({ selection, kind }: { selection: LibrarySelection; kind: "system" | "user" }) {
  if (selection === "default") {
    return <p className="rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">Each compare slot will use its strategy&apos;s built-in {kind === "system" ? "system prompt" : "user prompt template"}.</p>;
  }
  const strategy = getStrategy(selection);
  if (!strategy) return null;
  const text = kind === "system" ? strategy.systemPrompt : strategy.userTemplate;
  return (
    <details className={CLS.detailBox} open>
      <summary className={CLS.detailSummary}>{strategy.label}</summary>
      <pre className={CLS.detailBody}>{text}</pre>
    </details>
  );
}

function CompareResultPanel({ state }: { state: CompareState }) {
  const sorted = useMemo(() => [...state.results].sort((a, b) => compareComposite(a.score.composite, b.score.composite)), [state.results]);
  const onExport = () => {
    const first = state.results[0];
    downloadJson(
      `prompt-tester-compare-${sanitizeForFilename(first?.caseId ?? "compare")}-${exportTimestamp()}.json`,
      { kind: "compare", exportedAt: new Date().toISOString(), modelId: first?.modelId ?? "unknown", caseId: first?.caseId ?? "", expected: first?.expected ?? null, results: state.results, errors: state.errors },
    );
  };
  return (
    <div className="space-y-4">
      {state.errors.length > 0 ? <AlertBox tone="warn" message={state.errors.map((e) => `${e.strategyId}: ${e.error}`).join("\n")} /> : null}
      <div className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 p-3 text-xs">
        <div>
          <div className="font-medium text-gray-800">Expected</div>
          <p className="mt-0.5 text-gray-600">{state.results[0]?.expected.sentence ?? "(no result)"}</p>
        </div>
        <button type="button" onClick={onExport} disabled={state.results.length === 0} className={CLS.btnGhost}>
          <DownloadSimple size={13} weight="bold" /> Export JSON
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {sorted.map((entry) => <CompareResultCard key={entry.strategyId ?? entry.modelId} result={entry} />)}
      </div>
    </div>
  );
}

function SweepResultsPanel({ state, isRunning }: { state: SweepState; isRunning: boolean }) {
  const aggregates = useMemo(() => aggregateSweep(state), [state]);
  const completed = state.results.length;
  const percent = state.total === 0 ? 0 : Math.round((completed / state.total) * 100);
  const onExport = () => {
    const first = state.results[0]?.results[0];
    downloadJson(
      `prompt-tester-sweep-${sanitizeForFilename(state.suiteId)}-${exportTimestamp()}.json`,
      { kind: "sweep", exportedAt: new Date().toISOString(), modelId: first?.modelId ?? "unknown", suiteId: state.suiteId, total: state.total, completed, aggregates, cases: state.results },
    );
  };
  return (
    <div className="space-y-4">
      <div className="space-y-2 rounded-lg bg-gray-50 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium text-gray-800">Suite: {state.suiteId} — {completed}/{state.total} cases{isRunning ? " (running...)" : ""}</span>
          <div className="flex items-center gap-2">
            <span className="text-gray-500">{percent}%</span>
            <button type="button" onClick={onExport} disabled={completed === 0} className={CLS.btnGhost}>
              <DownloadSimple size={13} weight="bold" /> Export JSON
            </button>
          </div>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
          <div className="h-full bg-indigo-500 transition-[width] duration-300" style={{ width: `${percent}%` }} />
        </div>
        {aggregates.length > 0 ? (
          <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            {aggregates.map((agg) => (
              <div key={agg.strategyId} className="rounded-lg bg-white border border-gray-200 p-2 text-xs">
                <div className="font-medium text-gray-800">{agg.label}</div>
                <dl className="mt-1 space-y-0.5 text-[10px] text-gray-500">
                  {[
                    ["Score", formatPercent(agg.avgComposite)],
                    ["Exact", formatPercent(agg.exactRate)],
                    ["ROUGE-1", formatPercent(agg.avgRouge1)],
                    ["Signs", formatPercent(agg.avgSignUsage)],
                    ["Latency", `${Math.round(agg.avgLatencyMs)} ms`],
                    ["Cost", formatCost(agg.totalCost)],
                  ].map(([dt, dd]) => (
                    <div key={String(dt)} className="flex items-baseline gap-1">
                      <dt className="w-14 shrink-0">{dt}</dt>
                      <dd className="text-gray-800">{dd}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div className="space-y-3">
        {state.results.map((row) => <SweepCaseRow key={row.caseId} row={row} />)}
      </div>
    </div>
  );
}

function SweepCaseRow({ row }: { row: SweepCaseResult }) {
  const sorted = useMemo(() => [...row.results].sort((a, b) => compareComposite(a.score.composite, b.score.composite)), [row.results]);
  return (
    <div className="space-y-2 rounded-lg border border-gray-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span className="font-mono font-medium text-gray-900">{row.caseId}</span>
        <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-600">{row.topic}</span>
      </div>
      <p className="text-xs text-gray-600">Expected: <span className="text-gray-900">{row.expected.sentence}</span></p>
      {row.errors.length > 0 ? <AlertBox tone="warn" message={row.errors.map((e) => `${e.strategyId}: ${e.error}`).join("\n")} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {sorted.map((entry) => <CompareResultCard key={`${row.caseId}-${entry.strategyId ?? entry.modelId}`} result={entry} />)}
      </div>
    </div>
  );
}

function aggregateSweep(state: SweepState): readonly SweepAggregate[] {
  const buckets = new Map<string, PromptTesterRunResponse[]>();
  for (const row of state.results) {
    for (const result of row.results) {
      const key = result.strategyId ?? "(custom)";
      const bucket = buckets.get(key) ?? [];
      bucket.push(result);
      buckets.set(key, bucket);
    }
  }
  const aggregates: SweepAggregate[] = [];
  for (const [strategyId, results] of buckets) {
    if (results.length === 0) continue;
    const strategy = STRATEGIES.find((s) => s.id === strategyId);
    aggregates.push({
      strategyId,
      label: strategy?.label ?? strategyId,
      count: results.length,
      avgComposite: averageDefined(results.map((r) => r.score.composite)),
      exactRate: average(results.map((r) => r.score.sentenceExact)),
      avgRouge1: average(results.map((r) => r.score.rouge1Recall)),
      avgSignUsage: average(results.map((r) => r.score.signUsageRate)),
      avgLatencyMs: average(results.map((r) => r.latencyMs)),
      totalCost: results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
    });
  }
  return aggregates.sort((a, b) => b.avgComposite - a.avgComposite);
}

function CompareResultCard({ result }: { result: PromptTesterRunResponse }) {
  return (
    <div className="space-y-3 rounded-lg border border-gray-200 p-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="uppercase tracking-wide text-gray-400">{result.strategyId ?? "(custom)"}</span>
        <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-medium text-indigo-700">{formatPercent(result.score.composite)}</span>
      </div>
      <div>
        <div className="font-medium text-gray-800">Sentence</div>
        <p className="mt-0.5 text-gray-600">{result.parsed?.sentence ?? `(parse error: ${result.parseError ?? "unknown"})`}</p>
      </div>
      <dl className="space-y-0.5 text-xs">
        {[
          ["Exact", result.score.sentenceExact ? "yes" : "no"],
          ["ROUGE-1", formatPercent(result.score.rouge1Recall)],
          ["Embedding", result.score.embeddingSimilarity > 0 ? formatPercent(result.score.embeddingSimilarity) : "—"],
          ["Sign usage", formatPercent(result.score.signUsageRate)],
          ["Confidence", confidenceLabel(result.score.confidenceReported)],
          ["Latency", `${result.latencyMs} ms`],
          ["Cost", formatCost(result.costUsd)],
          ["Tokens in", result.usage?.inputTokens ?? "?"],
          ["Tokens out", result.usage?.outputTokens ?? "?"],
          ...(result.naturalness !== undefined ? [["Naturalness", formatPercent(result.naturalness)]] : []),
        ].map(([dt, dd]) => (
          <div key={String(dt)} className="flex items-baseline gap-1">
            <dt className="w-24 shrink-0 text-gray-400">{dt}</dt>
            <dd className="text-gray-800 font-medium">{dd}</dd>
          </div>
        ))}
      </dl>
      <details className={CLS.detailBox}>
        <summary className={CLS.detailSummary}>Raw response</summary>
        <pre className={CLS.detailBody}>{result.rawResponse}</pre>
      </details>
      <details className={CLS.detailBox}>
        <summary className={CLS.detailSummary}>User prompt</summary>
        <pre className={CLS.detailBody}>{result.prompt.user}</pre>
      </details>
    </div>
  );
}

function ComparePreview({ modelId, caseId, entries }: { modelId: string; caseId: string; entries: readonly CompiledStrategyPrompt[] }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 text-xs">
        {[["Model", modelId], ["Case", caseId]].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-gray-200 p-3">
            <div className="uppercase tracking-wide text-gray-400">{label}</div>
            <div className="mt-0.5 truncate font-mono text-sm text-gray-900">{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {entries.map(({ strategy, systemPrompt, compiledUser }) => {
          const overridden = systemPrompt !== strategy.systemPrompt;
          return (
            <div key={strategy.id} className="space-y-2 rounded-lg border border-gray-200 p-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="font-medium text-gray-900">{strategy.label}</div>
                {overridden ? <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-indigo-700">overridden</span> : null}
              </div>
              <p className="text-gray-500">{strategy.description}</p>
              <details className={CLS.detailBox}>
                <summary className={CLS.detailSummary}>System prompt</summary>
                <pre className={CLS.detailBody}>{systemPrompt}</pre>
              </details>
              <details className={CLS.detailBox} open>
                <summary className={CLS.detailSummary}>Compiled user prompt</summary>
                <pre className={CLS.detailBody}>{compiledUser}</pre>
              </details>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Modal (no external lib) ───────────────────────────────────────────────────

function SimpleModal({
  open,
  onClose,
  title,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    );
    focusable?.[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && focusable && focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="fixed left-1/2 top-1/2 z-50 w-full max-w-4xl -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white shadow-xl focus:outline-none"
      >
        <header className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          <button type="button" onClick={onClose} aria-label="Close"
            className="inline-flex size-8 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 focus-visible:outline-2 focus-visible:outline-indigo-500">
            <X size={16} />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-6 py-5">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-gray-200 px-6 py-4">{footer}</footer>
        ) : null}
      </div>
    </>
  );
}
