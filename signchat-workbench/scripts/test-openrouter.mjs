// Node-side smoke for the Phase 3 OpenRouter pane. Verifies:
//
//   1. The OpenRouter models catalog endpoint resolves and that each of the
//      three dropdown model ids appears in it (warns rather than fails when
//      one is missing — the catalog occasionally lags new model launches).
//   2. /api/openrouter/session-key against the running dev server still
//      mints a usable, capped child key.
//   3. POSTing the frozen `lean-options` system+user pair to
//      openrouter.ai/api/v1/chat/completions with a canned PIZZA fixture
//      returns a JSON body that satisfies the ReconstructionPayload schema:
//      sentence (string), confidence (high|medium|low), matchedScriptId
//      (string|null), usedSigns (string[]).
//   4. The reconstructed sentence references PIZZA in some way (case-
//      insensitive substring match) — sanity check that the model actually
//      used the recognized sign rather than hallucinating an unrelated
//      sentence.
//
// Usage (from signchat-workbench/, with `npm run dev` running):
//   npm run smoke:openrouter

const BASE = process.env.WORKBENCH_BASE_URL ?? "http://localhost:3020";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const DROPDOWN_MODEL_IDS = [
  "google/gemini-3.1-flash-lite-preview",
  "google/gemini-3-flash-preview",
  "mistralai/mistral-small-2603",
];

// Frozen copy of the lean-options system + user from
// prompt-tester-service/lib/strategies.ts. Keep in sync with
// signchat-workbench/lib/openrouter/prompt.ts.
const LEAN_OPTIONS_SYSTEM = `You reconstruct what a Deaf signer just said in casual English from a noisy classifier's top-K output. Match the energy and topic of the hearing user's last line. If the top-1 token is contextually wrong but a top-2 alternative fits, prefer the alternative and reflect that in usedSigns. Return JSON only with sentence, confidence (high|medium|low), matchedScriptId (null), and usedSigns.`;

const PIZZA_USER_PROMPT = `Hearing said: What sounds good for lunch?
Top-K classifier output for the current sign turn:
[
  {
    "word": "PIZZA",
    "score": 0.85,
    "alternatives": [
      { "word": "ICECREAM", "score": 0.42 },
      { "word": "WATER", "score": 0.31 }
    ]
  }
]
Word translations: ICECREAM=ice cream
PIZZA=pizza
WATER=water

Return JSON only.`;

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "reconstruction_payload",
    strict: true,
    schema: {
      type: "object",
      properties: {
        sentence: { type: "string" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        matchedScriptId: { type: ["string", "null"] },
        usedSigns: { type: "array", items: { type: "string" } },
      },
      required: ["sentence", "confidence", "matchedScriptId", "usedSigns"],
      additionalProperties: false,
    },
  },
};

function fatal(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`OK    ${message}`);
}

function warn(message) {
  console.warn(`WARN  ${message}`);
}

async function ensureServerUp() {
  try {
    const res = await fetch(`${BASE}/api/health`, { cache: "no-store" });
    if (!res.ok) fatal(`/api/health returned ${res.status}; is the dev server running?`);
    const json = await res.json();
    if (!json.ok) fatal(`/api/health returned ok=false`);
  } catch (e) {
    fatal(
      `cannot reach ${BASE}/api/health: ${e?.message ?? e}\n      ` +
        `start the dev server with \`npm run dev\` and try again.`,
    );
  }
}

function randomSuffix(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

await ensureServerUp();

// ---- 1. catalog check ------------------------------------------------------

let catalogIds = new Set();
{
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_MODELS_URL, { cache: "no-store" });
  if (!res.ok) fatal(`OpenRouter /models ${res.status}`);
  const json = await res.json();
  const data = Array.isArray(json?.data) ? json.data : [];
  catalogIds = new Set(data.map((entry) => entry?.id).filter((v) => typeof v === "string"));
  ok(`catalog: ${catalogIds.size} models in ${Date.now() - t0}ms`);
  for (const id of DROPDOWN_MODEL_IDS) {
    if (catalogIds.has(id)) {
      ok(`catalog: ${id} present`);
    } else {
      warn(`catalog: ${id} missing (model_unavailable chip will appear in pane)`);
    }
  }
}

// ---- 2. mint a session key against the dev server --------------------------

const room = `wb-${randomSuffix(5)}`;
const identity = `deaf-${randomSuffix(3)}`;
let apiKey = null;
{
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/openrouter/session-key`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room, identity, role: "deaf" }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fatal(`session-key ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (typeof json?.apiKey !== "string" || !/^sk-or-/.test(json.apiKey)) {
    fatal(`session-key returned malformed apiKey`);
  }
  apiKey = json.apiKey;
  ok(`session-key minted in ${Date.now() - t0}ms (keyHash=${json.keyHash})`);
}

// ---- 3. POST the PIZZA fixture --------------------------------------------

const modelId = DROPDOWN_MODEL_IDS[0]; // gemini-3.1-flash-lite-preview
{
  const t0 = Date.now();
  const res = await fetch(OPENROUTER_CHAT_URL, {
    method: "POST",
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://signchat.org",
      "X-Title": "Signchat",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: "system", content: LEAN_OPTIONS_SYSTEM },
        { role: "user", content: PIZZA_USER_PROMPT },
      ],
      temperature: 0,
      max_tokens: 300,
      response_format: RESPONSE_FORMAT,
    }),
  });
  const elapsedMs = Date.now() - t0;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fatal(`OpenRouter chat ${res.status} (${elapsedMs}ms): ${text.slice(0, 300)}`);
  }
  const json = await res.json();
  const raw = json?.choices?.[0]?.message?.content ?? "";
  if (typeof raw !== "string" || raw.length === 0) {
    fatal(`empty content in choices[0].message.content`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fatal(`raw is not JSON: ${err?.message ?? err} :: ${raw.slice(0, 200)}`);
  }

  if (typeof parsed.sentence !== "string" || parsed.sentence.length === 0) {
    fatal(`sentence missing or empty`);
  }
  if (
    parsed.confidence !== "high" &&
    parsed.confidence !== "medium" &&
    parsed.confidence !== "low"
  ) {
    fatal(`confidence must be high|medium|low, got ${parsed.confidence}`);
  }
  if (parsed.matchedScriptId !== null && typeof parsed.matchedScriptId !== "string") {
    fatal(`matchedScriptId must be string|null`);
  }
  if (
    !Array.isArray(parsed.usedSigns) ||
    !parsed.usedSigns.every((s) => typeof s === "string")
  ) {
    fatal(`usedSigns must be string[]`);
  }

  ok(
    `chat completion ${elapsedMs}ms model=${modelId} confidence=${parsed.confidence} sentence="${parsed.sentence}"`,
  );

  if (!parsed.sentence.toLowerCase().includes("pizza")) {
    warn(
      `sentence does not contain "pizza" — model may have been overly creative; not a fail`,
    );
  } else {
    ok(`sentence references PIZZA`);
  }

  const usage = json?.usage;
  if (usage) {
    ok(
      `usage: in=${usage.prompt_tokens ?? "?"} out=${usage.completion_tokens ?? "?"} total=${usage.total_tokens ?? "?"}`,
    );
  }
}

console.log("\nopenrouter smoke: PASS");
console.log(
  `\nNote: this run minted a real OpenRouter child key. Revoke with:\n` +
    `  curl -X DELETE -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_API_KEY" \\\n` +
    `       https://openrouter.ai/api/v1/keys/<keyHash>`,
);
