// Node-side smoke for the three credential-mint routes.
//
// Why: catch credential / endpoint / shape regressions before driving any
// browser. Hits the actual routes against a running dev server so the test
// also exercises Next.js middleware + env loading, not just provider calls.
//
// What it verifies:
//   1. /api/livekit/token returns a JWT + wsUrl with the expected fields
//   2. /api/openrouter/session-key mints a capped child key (sk-or-v1-*) +
//      stable keyHash + label
//   3. /api/elevenlabs/signed-url returns a wss:// URL with single_use_token
//      query param + 15-min expiry
//
// Usage (from signchat-workbench/, with `npm run dev` running):
//   npm run smoke:credentials

const BASE = process.env.WORKBENCH_BASE_URL ?? "http://localhost:3020";

function fatal(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`OK    ${message}`);
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

async function call(path, init = {}) {
  const startNs = process.hrtime.bigint();
  const res = await fetch(`${BASE}${path}`, { cache: "no-store", ...init });
  const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave json null
  }
  return { res, json, text, elapsedMs };
}

await ensureServerUp();

const room = `wb-${randomSuffix(5)}`;
const identity = `deaf-${randomSuffix(3)}`;

// ---- 1. livekit/token ------------------------------------------------------

{
  const url = `/api/livekit/token?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identity)}&role=deaf`;
  const { res, json, text, elapsedMs } = await call(url);
  if (!res.ok) fatal(`livekit/token ${res.status}: ${text.slice(0, 200)}`);
  if (!json || typeof json.token !== "string" || !json.token.startsWith("ey")) {
    fatal(`livekit/token: missing or malformed token`);
  }
  if (typeof json.wsUrl !== "string" || !json.wsUrl.startsWith("wss://")) {
    fatal(`livekit/token: wsUrl must be a wss:// URL`);
  }
  if (json.roomId !== room || json.identity !== identity || json.role !== "deaf") {
    fatal(`livekit/token: response did not echo room/identity/role`);
  }
  ok(
    `livekit/token         ${Math.round(elapsedMs)}ms  token=${json.token.slice(0, 8)}...${json.token.slice(-4)} wsUrl=${json.wsUrl}`,
  );
}

// ---- 2. openrouter/session-key ---------------------------------------------

let openrouterApiKey = null;
{
  const { res, json, text, elapsedMs } = await call("/api/openrouter/session-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room, identity, role: "deaf" }),
  });
  if (!res.ok) fatal(`openrouter/session-key ${res.status}: ${text.slice(0, 200)}`);
  if (!json || typeof json.apiKey !== "string" || !/^sk-or-/.test(json.apiKey)) {
    fatal(`openrouter/session-key: missing or unexpected apiKey shape`);
  }
  if (typeof json.keyHash !== "string" || json.keyHash.length < 8) {
    fatal(`openrouter/session-key: missing keyHash`);
  }
  if (
    typeof json.label !== "string" ||
    !json.label.startsWith(`signchat:${room}:${identity}:`)
  ) {
    fatal(`openrouter/session-key: label malformed`);
  }
  if (typeof json.limitCredits !== "number" || json.limitCredits <= 0) {
    fatal(`openrouter/session-key: limitCredits missing/non-positive`);
  }
  openrouterApiKey = json.apiKey;
  ok(
    `openrouter/session-key ${Math.round(elapsedMs)}ms  keyHash=${json.keyHash}  label=${json.label.slice(0, 40)}...`,
  );
}

// ---- 3. elevenlabs/signed-url ----------------------------------------------

{
  const { res, json, text, elapsedMs } = await call("/api/elevenlabs/signed-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room, identity, role: "deaf" }),
  });
  if (!res.ok) fatal(`elevenlabs/signed-url ${res.status}: ${text.slice(0, 200)}`);
  if (
    !json ||
    typeof json.signedUrl !== "string" ||
    !json.signedUrl.startsWith("wss://api.elevenlabs.io/")
  ) {
    fatal(`elevenlabs/signed-url: missing or unexpected signedUrl`);
  }
  if (!json.signedUrl.includes("single_use_token=")) {
    fatal(`elevenlabs/signed-url: signedUrl missing single_use_token query param`);
  }
  if (json.modelId !== "eleven_flash_v2_5" || json.outputFormat !== "pcm_24000") {
    fatal(`elevenlabs/signed-url: model/output mismatch`);
  }
  ok(
    `elevenlabs/signed-url  ${Math.round(elapsedMs)}ms  voiceId=${json.voiceId} expiresAt=${json.expiresAt}`,
  );
}

// ---- 4. role gating --------------------------------------------------------

{
  const { res, text } = await call("/api/openrouter/session-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId: room, identity, role: "hearing" }),
  });
  if (res.status !== 403) {
    fatal(
      `openrouter/session-key with role=hearing should return 403, got ${res.status}: ${text.slice(0, 100)}`,
    );
  }
  ok(`role gating: openrouter/session-key rejects role=hearing with 403`);
}

console.log("\ncredentials smoke: PASS");

// Bonus: print a hint that the test minted a real OR credit-cap key. Useful
// for the operator to know they should occasionally clean up unused keys
// from the OpenRouter dashboard.
if (openrouterApiKey) {
  console.log(
    `\nNote: this run minted a real OpenRouter child key. Revoke with:\n` +
      `  curl -X DELETE -H "Authorization: Bearer $OPENROUTER_MANAGEMENT_API_KEY" \\\n` +
      `       https://openrouter.ai/api/v1/keys/<keyHash>`,
  );
}
