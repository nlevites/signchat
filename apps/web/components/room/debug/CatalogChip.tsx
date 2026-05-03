"use client";

import { useEffect, useState } from "react";
import { LogBus } from "@/lib/diagnostics/log-bus";
import { cn } from "@/lib/cn";

const CATALOG_URL = "https://openrouter.ai/api/v1/models";

const KNOWN_MODEL_IDS = [
  "openai/gpt-5.4-mini",
  "google/gemini-3-flash-preview",
  "anthropic/claude-haiku-4.5",
  "x-ai/grok-4.1-fast",
] as const;

interface CatalogCheckResult {
  missing: readonly string[];
}

interface OpenRouterModelsResponse {
  data?: ReadonlyArray<{ id?: unknown }>;
}

// Module-scope cache so re-mounting the chip (or rendering twice) doesn't
// refetch. `force-cache` on the request gives us an HTTP-layer fallback too.
let cached: CatalogCheckResult | null = null;
let inflight: Promise<CatalogCheckResult> | null = null;

function loadCatalog(): Promise<CatalogCheckResult> {
  if (cached) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch(CATALOG_URL, { cache: "force-cache" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as OpenRouterModelsResponse;
      const data = Array.isArray(json.data) ? json.data : [];
      const ids = new Set<string>();
      for (const entry of data) {
        if (typeof entry.id === "string") ids.add(entry.id);
      }
      const missing = KNOWN_MODEL_IDS.filter((id) => !ids.has(id));
      if (missing.length > 0) {
        LogBus.warn(
          "catalog-chip",
          "OpenRouter catalog missing known model ids",
          { missing },
        );
      }
      cached = { missing };
      return cached;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      LogBus.warn("catalog-chip", "catalog fetch failed", { message });
      cached = { missing: [] };
      return cached;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function CatalogChip(): React.ReactElement | null {
  const [result, setResult] = useState<CatalogCheckResult | null>(cached);

  useEffect(() => {
    if (result) return;
    let cancelled = false;
    void loadCatalog().then((r) => {
      if (!cancelled) setResult(r);
    });
    return () => {
      cancelled = true;
    };
  }, [result]);

  if (!result) return null;

  if (result.missing.length > 0) {
    return (
      <span
        role="status"
        title={`Missing from OpenRouter catalog:\n${result.missing.join("\n")}`}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-sc-full border px-2.5 py-0.5 t-meta",
          "border-sc-warning/40 bg-sc-warning/15 text-sc-warning",
        )}
      >
        <span aria-hidden className="size-1.5 rounded-full bg-sc-warning" />
        model unavailable
      </span>
    );
  }

  return (
    <span
      role="status"
      title="All OpenRouter model ids present in catalog"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sc-full border px-2.5 py-0.5 t-meta",
        "border-sc-success/40 bg-sc-success/10 text-sc-success",
      )}
    >
      <span aria-hidden className="size-1.5 rounded-full bg-sc-success" />
      models ok
    </span>
  );
}
