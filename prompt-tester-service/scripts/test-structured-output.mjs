// Smoke-test each candidate model to verify OpenRouter supports it AND
// the provider returns a strict json_schema-shaped response.
//
// Usage (from prompt-tester-service/): node scripts/test-structured-output.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, "..", ".env"), "utf8");
    const env = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let value = trimmed.slice(idx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
    return env;
  } catch {
    return {};
  }
}

const fileEnv = loadEnv();
const API_KEY = process.env.OPENROUTER_API_KEY || fileEnv.OPENROUTER_API_KEY;

if (!API_KEY) {
  console.error("Missing OPENROUTER_API_KEY in env or .env");
  process.exit(1);
}

const MODELS = [
  "openai/gpt-5.4",
  "openai/gpt-5.4-nano",
  "~anthropic/claude-haiku-latest",
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
  "google/gemini-2.5-flash",
  "google/gemini-2.5-flash-lite",
  "meta-llama/llama-4-maverick",
  "mistralai/mistral-small-2603",
  "cohere/command-a",
];

const MAX_LATENCY_MS = 2000;

const SCHEMA = {
  type: "object",
  properties: {
    sentence: { type: "string" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    matchedScriptId: { type: ["string", "null"] },
    usedSigns: { type: "array", items: { type: "string" } },
  },
  required: ["sentence", "confidence", "matchedScriptId", "usedSigns"],
  additionalProperties: false,
};

async function testModel(model) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MAX_LATENCY_MS);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      signal: controller.signal,
      method: "POST",
      headers: {
        authorization: `Bearer ${API_KEY}`,
        "content-type": "application/json",
        "HTTP-Referer": "http://localhost:3010",
        "X-Title": "SignChat Prompt Tester (smoke test)",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content:
              "You reconstruct short ASL token streams into one casual English sentence. Return JSON only.",
          },
          {
            role: "user",
            content:
              "Recognized signs: HELLO, NICE, MEET. Hearing user said: 'Hey, nice to meet you!'. Return the JSON.",
          },
        ],
        temperature: 0,
        max_tokens: 300,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "reconstruction_payload",
            strict: true,
            schema: SCHEMA,
          },
        },
      }),
    });
    const latency = Date.now() - startedAt;
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      const message = body.replace(/\s+/g, " ").slice(0, 200);
      return { model, status: "FAIL", latency, note: `HTTP ${response.status}: ${message}` };
    }
    const json = await response.json();
    const content = json.choices?.[0]?.message?.content ?? "";
    if (!content) {
      return { model, status: "EMPTY", latency, note: "empty completion" };
    }
    try {
      const parsed = JSON.parse(content);
      const schemaOk =
        typeof parsed.sentence === "string" &&
        ["high", "medium", "low"].includes(parsed.confidence) &&
        (parsed.matchedScriptId === null || typeof parsed.matchedScriptId === "string") &&
        Array.isArray(parsed.usedSigns);
      return {
        model,
        status: schemaOk ? "OK" : "SHAPE",
        latency,
        note: JSON.stringify(parsed).slice(0, 80),
      };
    } catch {
      return {
        model,
        status: "PARSE",
        latency,
        note: content.replace(/\s+/g, " ").slice(0, 120),
      };
    }
  } catch (error) {
    return {
      model,
      status: error?.name === "AbortError" ? "TIMEOUT" : "ERROR",
      latency: Date.now() - startedAt,
      note: String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

const results = await Promise.all(MODELS.map(testModel));

const MODEL_COL = Math.max(...MODELS.map((m) => m.length), 5) + 2;
const STATUS_COL = 8;
const LAT_COL = 10;

console.log("\nStructured output compatibility report");
console.log("=".repeat(MODEL_COL + STATUS_COL + LAT_COL + 50));
console.log(
  "Model".padEnd(MODEL_COL) +
    "Status".padEnd(STATUS_COL) +
    "Latency".padStart(LAT_COL) +
    "  Notes",
);
console.log("-".repeat(MODEL_COL + STATUS_COL + LAT_COL + 50));

for (const result of results) {
  const latencyStr = `${result.latency}ms`.padStart(LAT_COL);
  console.log(
    result.model.padEnd(MODEL_COL) +
      result.status.padEnd(STATUS_COL) +
      latencyStr +
      "  " +
      result.note,
  );
}

const counts = results.reduce((acc, r) => {
  acc[r.status] = (acc[r.status] ?? 0) + 1;
  return acc;
}, {});
const okCount = counts.OK ?? 0;
console.log("-".repeat(MODEL_COL + STATUS_COL + LAT_COL + 50));
console.log(
  `${okCount}/${results.length} OK  |  ` +
    Object.entries(counts)
      .map(([status, count]) => `${status}=${count}`)
      .join("  "),
);

process.exit(0);
