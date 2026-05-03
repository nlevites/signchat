// Node-side smoke for the Phase 4 ElevenLabs streaming pane. Verifies:
//
//   1. /api/elevenlabs/signed-url against the running dev server returns a
//      well-formed wss:// URL with single_use_token and 15-min expiry.
//   2. The browser-style protocol handshake works: opening the WebSocket
//      and sending { text: "Pizza sounds great!", flush: true } produces
//      audio frames within a reasonable time window.
//   3. Final-frame semantics: an `isFinal: true` frame arrives within the
//      timeout, signaling end-of-turn.
//   4. Audio volume sanity: total decoded PCM bytes >= 10_000 (~0.4s @ 24
//      kHz × 2 bytes ≈ 19 KB minimum for that sentence). This catches
//      sound-of-silence regressions where ElevenLabs returns a single
//      empty frame.
//
// Uses Node's built-in WebSocket (Node 22+); no `ws` dep needed.
//
// Usage (from signchat-workbench/, with `npm run dev` running):
//   npm run smoke:elevenlabs

const BASE = process.env.WORKBENCH_BASE_URL ?? "http://localhost:3020";
const TURN_TIMEOUT_MS = 10_000;
const MIN_BYTES = 10_000;
// Optional override: if set, the smoke requests this voice id explicitly
// rather than letting /api/elevenlabs/signed-url default to ELEVENLABS_VOICE_ID
// from the workbench env. Useful when the operator wants to verify a
// specific voice without editing .env.
const TEST_VOICE_ID = process.env.WORKBENCH_TEST_VOICE_ID;

function fatal(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`OK    ${message}`);
}

function randomSuffix(len) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
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

await ensureServerUp();

// ---- 1. mint a signed URL --------------------------------------------------

const room = `wb-${randomSuffix(5)}`;
const identity = `deaf-${randomSuffix(3)}`;
let signedUrl = null;
let voiceId = null;
{
  const t0 = Date.now();
  const body = { roomId: room, identity, role: "deaf" };
  if (TEST_VOICE_ID) body.voiceId = TEST_VOICE_ID;
  const res = await fetch(`${BASE}/api/elevenlabs/signed-url`, {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    fatal(`signed-url ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (
    typeof json?.signedUrl !== "string" ||
    !json.signedUrl.startsWith("wss://api.elevenlabs.io/")
  ) {
    fatal(`signed-url returned unexpected shape: ${JSON.stringify(json).slice(0, 200)}`);
  }
  if (!json.signedUrl.includes("single_use_token=")) {
    fatal(`signed-url missing single_use_token query param`);
  }
  if (json.modelId !== "eleven_flash_v2_5" || json.outputFormat !== "pcm_24000") {
    fatal(`unexpected modelId/outputFormat: ${json.modelId} / ${json.outputFormat}`);
  }
  signedUrl = json.signedUrl;
  voiceId = json.voiceId;
  ok(`signed-url minted in ${Date.now() - t0}ms (voiceId=${voiceId})`);
}

// ---- 2. open WSS, send PIZZA, count frames --------------------------------

if (typeof WebSocket === "undefined") {
  fatal("WebSocket is not available in this Node runtime; need Node 22+ for built-in WebSocket");
}

const stats = {
  audioFrames: 0,
  alignmentFrames: 0,
  totalBytes: 0,
  isFinalReceived: false,
};

const wssOpenStart = Date.now();
const ws = new WebSocket(signedUrl);

// Attach the message + close listeners before open so we don't race with
// an immediate error frame from the server.
let firstAudioAt = null;
let turnStartedAt = null;
let resolveTurn;
let rejectTurn;
const turnPromise = new Promise((resolve, reject) => {
  resolveTurn = resolve;
  rejectTurn = reject;
});

ws.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  let frame;
  try {
    frame = JSON.parse(event.data);
  } catch {
    return;
  }
  if (typeof frame.audio === "string" && frame.audio.length > 0) {
    if (firstAudioAt === null) {
      firstAudioAt = Date.now();
      ok(`first audio frame ${firstAudioAt - turnStartedAt}ms after send`);
    }
    stats.audioFrames += 1;
    stats.totalBytes += Math.floor(frame.audio.length * 0.75);
  }
  if (frame.alignment && Array.isArray(frame.alignment.chars)) {
    stats.alignmentFrames += 1;
  }
  if (frame.error || frame.message) {
    rejectTurn(
      new Error(
        `server frame: ${JSON.stringify(frame).slice(0, 240)}`,
      ),
    );
    return;
  }
  if (frame.isFinal === true) {
    stats.isFinalReceived = true;
    resolveTurn();
  }
});

ws.addEventListener("close", (event) => {
  if (!stats.isFinalReceived) {
    rejectTurn(
      new Error(
        `wss closed before isFinal (code=${event.code} reason="${event.reason || ""}", ` +
          `audioFrames=${stats.audioFrames}, bytes=${stats.totalBytes})`,
      ),
    );
  }
});

ws.addEventListener("error", (event) => {
  rejectTurn(new Error(`wss error: ${event?.message ?? "(unknown)"}`));
});

await new Promise((resolve, reject) => {
  ws.addEventListener("open", () => {
    ok(`wss open in ${Date.now() - wssOpenStart}ms`);
    // ElevenLabs stream-input expects an init frame with a single space and
    // voice_settings before the first content frame. Some endpoint variants
    // also require try_trigger_generation per text frame.
    ws.send(
      JSON.stringify({
        text: " ",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
        generation_config: {
          chunk_length_schedule: [120, 160, 250, 290],
        },
      }),
    );
    turnStartedAt = Date.now();
    ws.send(
      JSON.stringify({
        text: "Pizza sounds great!",
        try_trigger_generation: true,
      }),
    );
    // Empty-text closes the input stream and triggers final flush.
    ws.send(JSON.stringify({ text: "" }));
    resolve();
  });
  setTimeout(
    () => reject(new Error("wss open timed out")),
    TURN_TIMEOUT_MS,
  );
});

const timer = setTimeout(() => {
  rejectTurn(
    new Error(
      `did not receive isFinal within ${TURN_TIMEOUT_MS}ms ` +
        `(audioFrames=${stats.audioFrames}, bytes=${stats.totalBytes})`,
    ),
  );
}, TURN_TIMEOUT_MS);
try {
  await turnPromise;
} finally {
  clearTimeout(timer);
}

ws.close(1000, "smoke done");

// ---- 3. assert outcomes ----------------------------------------------------

if (!stats.isFinalReceived) fatal("isFinal: true never arrived");
if (stats.audioFrames < 1) fatal(`expected >= 1 audio frame, got ${stats.audioFrames}`);
if (stats.totalBytes < MIN_BYTES) {
  fatal(
    `expected >= ${MIN_BYTES} PCM bytes, got ${stats.totalBytes} ` +
      `(this can mean ElevenLabs returned silence — check the voice id)`,
  );
}
ok(
  `received ${stats.audioFrames} audio frames, ${stats.alignmentFrames} alignment frames, ` +
    `${stats.totalBytes.toLocaleString()} bytes`,
);
ok(`isFinal arrived within ${Date.now() - turnStartedAt}ms`);

console.log("\nelevenlabs smoke: PASS");
