// Reads raw per-result JSON files from results/lean-options-sweep/<runId>/raw
// and emits chart-ready aggregates under charts/, plus by-model and by-suite
// rollups and a top-level run-summary.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface ScoreBreakdown {
  jsonValid: number;
  sentenceExact: number;
  rouge1Recall: number;
  embeddingSimilarity: number;
  signUsageRate: number;
  confidenceReported: number;
  composite: number | null;
}

interface RawRecord {
  runId: string;
  createdAt: string;
  modelId: string;
  strategyId: string;
  suite: string;
  caseId: string;
  baseTurnId: string;
  topic: string;
  judgeEnabled: boolean;
  embeddingsEnabled: boolean;
  response: {
    rawContent: string;
    parsed: unknown;
    parseError: string | null;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
    costUsd?: number;
  };
  score: ScoreBreakdown;
  naturalness?: number;
  embeddingSimilarity: number;
  latencyMs: number;
  status: "ok" | "timeout" | "http_error" | "empty" | "network_error";
  error?: string;
  retries: number;
}

interface ModelSummary {
  modelId: string;
  modelFamily: string;
  label: string;
  count: number;
  okCount: number;
  failureRate: number;
  timeoutRate: number;
  under2sRate: number;
  exactRate: number;
  jsonValidRate: number;
  avgComposite: number | null;
  avgNaturalness: number | null;
  avgRouge1: number;
  avgSignUsage: number;
  avgEmbedding: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p90LatencyMs: number;
  p95LatencyMs: number;
  maxLatencyMs: number;
  avgCostUsd: number | null;
  totalCostUsd: number | null;
  inputTokensAvg: number | null;
  outputTokensAvg: number | null;
  statusCounts: Record<string, number>;
}

async function readAllRawRecords(runDir: string): Promise<RawRecord[]> {
  const rawDir = join(runDir, "raw");
  const results: RawRecord[] = [];
  await walk(rawDir, (file) => {
    if (!file.endsWith(".json")) return;
    try {
      const content = readFileSync(file, "utf8");
      const parsed = JSON.parse(content) as RawRecord;
      results.push(parsed);
    } catch (error) {
      console.warn(`skipping unreadable ${file}: ${(error as Error).message}`);
    }
  });
  return results;
}

async function walk(dir: string, handler: (file: string) => void): Promise<void> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, handler);
    } else if (entry.isFile()) {
      handler(full);
    }
  }
}

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function meanOrNull(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return mean(values);
}

function round(value: number | null, digits = 4): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function modelFamily(modelId: string): string {
  const id = modelId.replace(/^~/, "");
  return id.split("/")[0] ?? "unknown";
}

function modelLabel(modelId: string): string {
  const id = modelId.replace(/^~/, "");
  return id.split("/").slice(1).join("/") || modelId;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

function buildModelSummaries(records: readonly RawRecord[]): ModelSummary[] {
  const byModel = new Map<string, RawRecord[]>();
  for (const record of records) {
    const bucket = byModel.get(record.modelId) ?? [];
    bucket.push(record);
    byModel.set(record.modelId, bucket);
  }
  const summaries: ModelSummary[] = [];
  for (const [modelId, bucket] of byModel) {
    const ok = bucket.filter((r) => r.status === "ok" && r.response.parsed);
    const latencyValues = bucket.map((r) => r.latencyMs);
    const compositeValues = ok
      .map((r) => r.score.composite)
      .filter((v): v is number => typeof v === "number");
    const naturalnessValues = ok
      .map((r) => r.naturalness)
      .filter((v): v is number => typeof v === "number");
    const costValues = ok
      .map((r) => r.response.costUsd)
      .filter((v): v is number => typeof v === "number");
    const inputTokensValues = ok
      .map((r) => r.response.usage?.inputTokens)
      .filter((v): v is number => typeof v === "number");
    const outputTokensValues = ok
      .map((r) => r.response.usage?.outputTokens)
      .filter((v): v is number => typeof v === "number");

    const statusCounts: Record<string, number> = {};
    for (const r of bucket) {
      statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    }

    summaries.push({
      modelId,
      modelFamily: modelFamily(modelId),
      label: modelLabel(modelId),
      count: bucket.length,
      okCount: ok.length,
      failureRate: round(1 - ok.length / bucket.length)!,
      timeoutRate: round(
        bucket.filter((r) => r.status === "timeout").length / bucket.length,
      )!,
      under2sRate: round(
        latencyValues.filter((v) => v < 2000).length / bucket.length,
      )!,
      exactRate: round(mean(ok.map((r) => r.score.sentenceExact)))!,
      jsonValidRate: round(mean(ok.map((r) => r.score.jsonValid)))!,
      avgComposite: round(meanOrNull(compositeValues)),
      avgNaturalness: round(meanOrNull(naturalnessValues)),
      avgRouge1: round(mean(ok.map((r) => r.score.rouge1Recall)))!,
      avgSignUsage: round(mean(ok.map((r) => r.score.signUsageRate)))!,
      avgEmbedding: round(mean(ok.map((r) => r.score.embeddingSimilarity)))!,
      avgLatencyMs: round(mean(latencyValues), 1)!,
      p50LatencyMs: Math.round(percentile(latencyValues, 50)),
      p90LatencyMs: Math.round(percentile(latencyValues, 90)),
      p95LatencyMs: Math.round(percentile(latencyValues, 95)),
      maxLatencyMs: latencyValues.length === 0 ? 0 : Math.max(...latencyValues),
      avgCostUsd: costValues.length === 0 ? null : round(mean(costValues), 6),
      totalCostUsd:
        costValues.length === 0
          ? null
          : round(costValues.reduce((s, v) => s + v, 0), 6),
      inputTokensAvg: inputTokensValues.length === 0 ? null : round(mean(inputTokensValues), 1),
      outputTokensAvg: outputTokensValues.length === 0 ? null : round(mean(outputTokensValues), 1),
      statusCounts,
    });
  }
  return summaries.sort((a, b) => (b.avgComposite ?? -1) - (a.avgComposite ?? -1));
}

interface SuiteCell {
  modelId: string;
  suite: string;
  count: number;
  avgComposite: number | null;
  avgNaturalness: number | null;
  exactRate: number;
  avgRouge1: number;
  avgSignUsage: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  failureRate: number;
}

function buildSuiteSummaries(records: readonly RawRecord[]): SuiteCell[] {
  const groups = new Map<string, RawRecord[]>();
  for (const r of records) {
    const key = `${r.modelId}|${r.suite}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(r);
    groups.set(key, bucket);
  }
  const rows: SuiteCell[] = [];
  for (const [key, bucket] of groups) {
    const [modelId, suite] = key.split("|", 2) as [string, string];
    const ok = bucket.filter((r) => r.status === "ok" && r.response.parsed);
    const latencyValues = bucket.map((r) => r.latencyMs);
    const compositeValues = ok
      .map((r) => r.score.composite)
      .filter((v): v is number => typeof v === "number");
    const naturalnessValues = ok
      .map((r) => r.naturalness)
      .filter((v): v is number => typeof v === "number");
    rows.push({
      modelId,
      suite,
      count: bucket.length,
      avgComposite: round(meanOrNull(compositeValues)),
      avgNaturalness: round(meanOrNull(naturalnessValues)),
      exactRate: round(mean(ok.map((r) => r.score.sentenceExact)))!,
      avgRouge1: round(mean(ok.map((r) => r.score.rouge1Recall)))!,
      avgSignUsage: round(mean(ok.map((r) => r.score.signUsageRate)))!,
      avgLatencyMs: round(mean(latencyValues), 1)!,
      p95LatencyMs: Math.round(percentile(latencyValues, 95)),
      failureRate: round(1 - ok.length / bucket.length)!,
    });
  }
  return rows.sort((a, b) => a.modelId.localeCompare(b.modelId) || a.suite.localeCompare(b.suite));
}

function histogram(values: readonly number[], bins: number): { bins: number[]; counts: number[] } {
  if (values.length === 0) return { bins: [], counts: [] };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { bins: [min, max + 1], counts: [values.length] };
  const step = (max - min) / bins;
  const edges = Array.from({ length: bins + 1 }, (_, i) => round(min + i * step, 3)!);
  const counts = new Array<number>(bins).fill(0);
  for (const v of values) {
    const bucket = Math.min(bins - 1, Math.floor((v - min) / step));
    counts[bucket] += 1;
  }
  return { bins: edges, counts };
}

function paretoFrontierMaximizeMinimize<T>(
  items: readonly T[],
  getX: (item: T) => number, // minimize
  getY: (item: T) => number, // maximize
): T[] {
  const sorted = [...items].sort((a, b) => getX(a) - getX(b));
  const frontier: T[] = [];
  let bestY = -Infinity;
  for (const item of sorted) {
    const y = getY(item);
    if (y > bestY) {
      frontier.push(item);
      bestY = y;
    }
  }
  return frontier;
}

function paretoFrontierMinimizeMinimize<T>(
  items: readonly T[],
  getX: (item: T) => number, // minimize
  getY: (item: T) => number, // minimize
): T[] {
  const sorted = [...items].sort((a, b) => getX(a) - getX(b));
  const frontier: T[] = [];
  let bestY = Infinity;
  for (const item of sorted) {
    const y = getY(item);
    if (y < bestY) {
      frontier.push(item);
      bestY = y;
    }
  }
  return frontier;
}

export async function summarizeRun(args: {
  runDir: string;
  modelIds: readonly string[];
}): Promise<void> {
  const records = await readAllRawRecords(args.runDir);
  if (records.length === 0) {
    console.warn("No raw records found to summarize.");
    return;
  }

  const models = buildModelSummaries(records);
  const suites = buildSuiteSummaries(records);

  // by-model / by-suite rollups
  for (const model of models) {
    const modelRecords = records.filter((r) => r.modelId === model.modelId);
    await writeJson(
      join(args.runDir, "by-model", `${model.modelId.replace(/~/g, "").replace(/\//g, "__")}.json`),
      { summary: model, records: modelRecords },
    );
  }
  const suiteIds = [...new Set(records.map((r) => r.suite))].sort();
  for (const suiteId of suiteIds) {
    const suiteRecords = records.filter((r) => r.suite === suiteId);
    const suiteRows = suites.filter((s) => s.suite === suiteId);
    await writeJson(join(args.runDir, "by-suite", `${suiteId}.json`), {
      suite: suiteId,
      perModel: suiteRows,
      records: suiteRecords,
    });
  }

  // model-summary.json
  await writeJson(join(args.runDir, "charts", "model-summary.json"), { models });

  // suite-summary.json
  await writeJson(join(args.runDir, "charts", "suite-summary.json"), { cells: suites });

  // scatter-latency-score.json
  await writeJson(join(args.runDir, "charts", "scatter-latency-score.json"), {
    title: "Latency vs Overall Score",
    x: { field: "p50LatencyMs", label: "p50 latency (ms)", unit: "ms" },
    y: { field: "avgComposite", label: "Avg composite score", unit: "0-1" },
    size: { field: "count", label: "cases", unit: "count" },
    color: { field: "modelFamily", label: "Model family" },
    points: models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      x: m.p50LatencyMs,
      y: m.avgComposite,
      size: m.count,
      p95Latency: m.p95LatencyMs,
      avgNaturalness: m.avgNaturalness,
    })),
  });

  // scatter-cost-score.json
  await writeJson(join(args.runDir, "charts", "scatter-cost-score.json"), {
    title: "Cost vs Overall Score",
    x: { field: "avgCostUsd", label: "Avg cost per case (USD)", unit: "USD" },
    y: { field: "avgComposite", label: "Avg composite score", unit: "0-1" },
    size: { field: "totalCostUsd", label: "Total cost (USD)", unit: "USD" },
    color: { field: "modelFamily", label: "Model family" },
    points: models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      x: m.avgCostUsd,
      y: m.avgComposite,
      size: m.totalCostUsd,
      avgNaturalness: m.avgNaturalness,
    })),
  });

  // scatter-latency-cost.json
  await writeJson(join(args.runDir, "charts", "scatter-latency-cost.json"), {
    title: "Latency vs Cost",
    x: { field: "p95LatencyMs", label: "p95 latency (ms)", unit: "ms" },
    y: { field: "avgCostUsd", label: "Avg cost per case (USD)", unit: "USD" },
    size: { field: "avgComposite", label: "Avg composite score", unit: "0-1" },
    color: { field: "under2sRate", label: "Under-2s rate" },
    points: models.map((m) => ({
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      x: m.p95LatencyMs,
      y: m.avgCostUsd,
      size: m.avgComposite,
      under2sRate: m.under2sRate,
    })),
  });

  // pareto-frontier.json
  const scoreLatencyFrontier = paretoFrontierMaximizeMinimize(
    models.filter((m) => m.avgComposite !== null),
    (m) => m.p50LatencyMs,
    (m) => m.avgComposite ?? 0,
  );
  const scoreCostFrontier = paretoFrontierMaximizeMinimize(
    models.filter((m) => m.avgComposite !== null && m.avgCostUsd !== null),
    (m) => m.avgCostUsd ?? Infinity,
    (m) => m.avgComposite ?? 0,
  );
  const scoreFloor = 0.7;
  const latencyCostFrontier = paretoFrontierMinimizeMinimize(
    models.filter(
      (m) =>
        m.avgCostUsd !== null && m.avgComposite !== null && (m.avgComposite ?? 0) >= scoreFloor,
    ),
    (m) => m.p50LatencyMs,
    (m) => m.avgCostUsd ?? Infinity,
  );
  await writeJson(join(args.runDir, "charts", "pareto-frontier.json"), {
    scoreLatency: {
      title: "Pareto frontier: max score, min p50 latency",
      frontier: scoreLatencyFrontier.map((m) => m.modelId),
    },
    scoreCost: {
      title: "Pareto frontier: max score, min avg cost",
      frontier: scoreCostFrontier.map((m) => m.modelId),
    },
    latencyCostFloor: {
      title: `Pareto frontier: min latency, min cost (score >= ${scoreFloor})`,
      scoreFloor,
      frontier: latencyCostFrontier.map((m) => m.modelId),
    },
    allModels: models.map((m) => ({
      modelId: m.modelId,
      avgComposite: m.avgComposite,
      p50LatencyMs: m.p50LatencyMs,
      avgCostUsd: m.avgCostUsd,
    })),
  });

  // latency-distribution.json
  const latencyPerModel = models.map((m) => {
    const values = records
      .filter((r) => r.modelId === m.modelId)
      .map((r) => r.latencyMs);
    return {
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      samples: values,
      histogram: histogram(values, 15),
      p50: m.p50LatencyMs,
      p90: m.p90LatencyMs,
      p95: m.p95LatencyMs,
      max: m.maxLatencyMs,
      avg: m.avgLatencyMs,
    };
  });
  await writeJson(join(args.runDir, "charts", "latency-distribution.json"), {
    title: "Latency distribution by model",
    unit: "ms",
    perModel: latencyPerModel,
  });

  // score-distribution.json
  const scorePerModel = models.map((m) => {
    const values = records
      .filter((r) => r.modelId === m.modelId && r.status === "ok" && r.score.composite !== null)
      .map((r) => r.score.composite as number);
    return {
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      samples: values,
      histogram: histogram(values, 10),
      avg: m.avgComposite,
    };
  });
  await writeJson(join(args.runDir, "charts", "score-distribution.json"), {
    title: "Composite score distribution by model",
    unit: "0-1",
    perModel: scorePerModel,
  });

  // cost-distribution.json
  const costPerModel = models.map((m) => {
    const values = records
      .filter((r) => r.modelId === m.modelId && typeof r.response.costUsd === "number")
      .map((r) => r.response.costUsd as number);
    return {
      modelId: m.modelId,
      label: m.label,
      family: m.modelFamily,
      samples: values,
      histogram: histogram(values, 10),
      avg: m.avgCostUsd,
      total: m.totalCostUsd,
    };
  });
  await writeJson(join(args.runDir, "charts", "cost-distribution.json"), {
    title: "Cost per case distribution by model",
    unit: "USD",
    perModel: costPerModel,
  });

  // error-cases.json
  const failures = records
    .filter((r) => r.status !== "ok" || !r.response.parsed)
    .map((r) => ({
      modelId: r.modelId,
      suite: r.suite,
      caseId: r.caseId,
      status: r.status,
      error: r.error ?? r.response.parseError ?? null,
      latencyMs: r.latencyMs,
      rawContentPreview: r.response.rawContent?.slice(0, 200) ?? "",
    }));
  const lowestScores = records
    .filter((r) => r.status === "ok" && typeof r.score.composite === "number")
    .sort(
      (a, b) =>
        (a.score.composite as number) - (b.score.composite as number),
    )
    .slice(0, 100)
    .map((r) => ({
      modelId: r.modelId,
      suite: r.suite,
      caseId: r.caseId,
      composite: r.score.composite,
      sentenceExact: r.score.sentenceExact,
      latencyMs: r.latencyMs,
    }));
  await writeJson(join(args.runDir, "charts", "error-cases.json"), {
    failures,
    lowestScoring: lowestScores,
  });

  // chart-specs.json — declarative metadata for the rendering step
  await writeJson(join(args.runDir, "charts", "chart-specs.json"), {
    charts: [
      {
        id: "latency-vs-score",
        title: "Latency vs Overall Score",
        type: "scatter",
        dataset: "scatter-latency-score.json",
        xField: "x",
        yField: "y",
        sizeField: "size",
        colorField: "family",
        xLabel: "p50 latency (ms)",
        yLabel: "Avg composite score (0-1)",
      },
      {
        id: "cost-vs-score",
        title: "Cost vs Overall Score",
        type: "scatter",
        dataset: "scatter-cost-score.json",
        xField: "x",
        yField: "y",
        sizeField: "size",
        colorField: "family",
        xLabel: "Avg cost per case (USD)",
        yLabel: "Avg composite score (0-1)",
      },
      {
        id: "latency-vs-cost",
        title: "Latency vs Cost",
        type: "scatter",
        dataset: "scatter-latency-cost.json",
        xField: "x",
        yField: "y",
        sizeField: "size",
        colorField: "under2sRate",
        xLabel: "p95 latency (ms)",
        yLabel: "Avg cost per case (USD)",
      },
      {
        id: "suite-heatmap",
        title: "Score by suite heatmap",
        type: "heatmap",
        dataset: "suite-summary.json",
        xField: "suite",
        yField: "modelId",
        valueField: "avgComposite",
      },
      {
        id: "latency-distribution",
        title: "Latency distribution by model",
        type: "violin",
        dataset: "latency-distribution.json",
        valueField: "samples",
        groupField: "modelId",
        unit: "ms",
      },
      {
        id: "score-distribution",
        title: "Composite score distribution by model",
        type: "violin",
        dataset: "score-distribution.json",
        valueField: "samples",
        groupField: "modelId",
        unit: "0-1",
      },
      {
        id: "cost-distribution",
        title: "Cost distribution by model",
        type: "violin",
        dataset: "cost-distribution.json",
        valueField: "samples",
        groupField: "modelId",
        unit: "USD",
      },
      {
        id: "pareto-frontier",
        title: "Pareto-optimal models",
        type: "pareto",
        dataset: "pareto-frontier.json",
      },
    ],
  });

  // run-summary.json — the tl;dr
  const bestByScore = models
    .filter((m) => m.avgComposite !== null)
    .sort((a, b) => (b.avgComposite ?? 0) - (a.avgComposite ?? 0));
  const bestByLatency = [...models].sort((a, b) => a.p95LatencyMs - b.p95LatencyMs);
  const bestByCost = models
    .filter((m) => m.avgCostUsd !== null)
    .sort((a, b) => (a.avgCostUsd ?? Infinity) - (b.avgCostUsd ?? Infinity));
  const worstSuites = suites
    .filter((s) => s.avgComposite !== null)
    .sort((a, b) => (a.avgComposite ?? 0) - (b.avgComposite ?? 0))
    .slice(0, 10);
  await writeJson(join(args.runDir, "run-summary.json"), {
    generatedAt: new Date().toISOString(),
    totalRecords: records.length,
    modelCount: models.length,
    bestByCompositeTop3: bestByScore.slice(0, 3).map((m) => m.modelId),
    bestByP95LatencyTop3: bestByLatency.slice(0, 3).map((m) => m.modelId),
    bestByCostTop3: bestByCost.slice(0, 3).map((m) => m.modelId),
    worstSuiteCells: worstSuites,
    scoreLatencyPareto: scoreLatencyFrontier.map((m) => m.modelId),
    scoreCostPareto: scoreCostFrontier.map((m) => m.modelId),
    latencyCostParetoFloor: latencyCostFrontier.map((m) => m.modelId),
  });
}

// CLI entry when invoked directly: `npx tsx scripts/lean-options-sweep/summarize.ts <runDir>`
const isDirect = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();
if (isDirect) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error("Usage: tsx summarize.ts <runDir>");
    process.exit(1);
  }
  summarizeRun({ runDir, modelIds: [] }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
