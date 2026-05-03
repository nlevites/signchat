// Node-side smoke for the Phase 2 LiveKit pane. Verifies:
//
//   1. Two distinct identities can mint JWTs against the same room and that
//      both tokens decode to the right grants for ARCHITECTURE.md §10.1
//      (roomJoin + canPublish + canSubscribe + canPublishData) and TTL ~ 1h.
//   2. Both tokens echo the room/identity/role they were minted for.
//   3. Two different identities in the same room produce two different
//      tokens (catches accidental caching).
//   4. The wsUrl is a wss:// URL, not the management API URL.
//
// Browser-only paths (Room.connect, publishTrack, DataChannel send/recv) are
// verified manually by opening two tabs of the workbench. A Playwright
// two-tab smoke is intentionally deferred to the Phase 6 plan.
//
// Usage (from signchat-workbench/, with `npm run dev` running):
//   npm run smoke:livekit

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

async function call(path) {
  const startNs = process.hrtime.bigint();
  const res = await fetch(`${BASE}${path}`, { cache: "no-store" });
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

function decodeJwt(token) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    fatal(`token does not have three dot-separated parts (got ${parts.length})`);
  }
  // Base64url -> base64 (replace -_, pad with =).
  const pad = (s) => s + "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s) => pad(s.replaceAll("-", "+").replaceAll("_", "/"));
  const header = JSON.parse(Buffer.from(b64(parts[0]), "base64").toString("utf8"));
  const payload = JSON.parse(Buffer.from(b64(parts[1]), "base64").toString("utf8"));
  return { header, payload };
}

function assertGrant(payload, identity, room) {
  // livekit-server-sdk emits `exp` + `nbf` but not `iat`. Derive TTL from
  // wall-clock now() instead — we want to assert it sits in the §10.1 ~1h
  // window regardless of how the SDK structures the claim set.
  if (typeof payload.exp !== "number") {
    fatal(`token: missing exp claim`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const ttl = payload.exp - nowSec;
  if (ttl < 55 * 60 || ttl > 65 * 60) {
    fatal(`token: TTL ${ttl}s out of expected ~3600s window`);
  }
  if (payload.sub !== identity && payload.identity !== identity) {
    fatal(
      `token: subject (sub=${payload.sub}, identity=${payload.identity}) does not match expected identity ${identity}`,
    );
  }
  const video = payload.video;
  if (!video || typeof video !== "object") {
    fatal(`token: missing video grant`);
  }
  if (video.room !== room) {
    fatal(`token: video.room=${video.room} but expected ${room}`);
  }
  for (const flag of ["roomJoin", "canPublish", "canSubscribe", "canPublishData"]) {
    if (video[flag] !== true) {
      fatal(`token: video.${flag} is not true (got ${video[flag]})`);
    }
  }
}

await ensureServerUp();

const room = `wb-${randomSuffix(5)}`;
const identityA = `alice-${randomSuffix(3)}`;
const identityB = `bob-${randomSuffix(3)}`;

// ---- 1. mint two distinct tokens for the same room ------------------------

let tokenA = null;
let tokenB = null;
let wsUrl = null;

{
  const url = `/api/livekit/token?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identityA)}&role=hearing`;
  const { res, json, text, elapsedMs } = await call(url);
  if (!res.ok) fatal(`livekit/token alice ${res.status}: ${text.slice(0, 200)}`);
  if (typeof json?.token !== "string") fatal(`livekit/token alice: missing token`);
  if (typeof json?.wsUrl !== "string" || !json.wsUrl.startsWith("wss://")) {
    fatal(`livekit/token alice: wsUrl must be wss:// (got ${json?.wsUrl})`);
  }
  if (json.roomId !== room || json.identity !== identityA || json.role !== "hearing") {
    fatal(`livekit/token alice: response did not echo room/identity/role`);
  }
  tokenA = json.token;
  wsUrl = json.wsUrl;
  ok(`mint alice (${identityA})  ${Math.round(elapsedMs)}ms`);
}

{
  const url = `/api/livekit/token?room=${encodeURIComponent(room)}&identity=${encodeURIComponent(identityB)}&role=deaf`;
  const { res, json, text, elapsedMs } = await call(url);
  if (!res.ok) fatal(`livekit/token bob ${res.status}: ${text.slice(0, 200)}`);
  if (typeof json?.token !== "string") fatal(`livekit/token bob: missing token`);
  if (json.roomId !== room || json.identity !== identityB || json.role !== "deaf") {
    fatal(`livekit/token bob: response did not echo room/identity/role`);
  }
  tokenB = json.token;
  ok(`mint bob   (${identityB})  ${Math.round(elapsedMs)}ms`);
}

if (tokenA === tokenB) fatal(`alice and bob received the same token`);
ok(`two distinct identities produce distinct tokens`);
ok(`wsUrl is wss:// (${wsUrl})`);

// ---- 2. decode + verify grants on each ------------------------------------

const { header: headerA, payload: payloadA } = decodeJwt(tokenA);
const { header: headerB, payload: payloadB } = decodeJwt(tokenB);

if (headerA.alg !== "HS256") fatal(`alice: alg=${headerA.alg}, expected HS256`);
if (headerB.alg !== "HS256") fatal(`bob: alg=${headerB.alg}, expected HS256`);
ok(`tokens use HS256`);

assertGrant(payloadA, identityA, room);
ok(`alice grants ok: roomJoin/canPublish/canSubscribe/canPublishData + 1h TTL`);

assertGrant(payloadB, identityB, room);
ok(`bob   grants ok: roomJoin/canPublish/canSubscribe/canPublishData + 1h TTL`);

// ---- 3. issuer is the LiveKit project key, not the management key ---------
// Both tokens are signed by the same project secret, so iss must match.

if (payloadA.iss !== payloadB.iss) {
  fatal(`tokens issued by different keys: ${payloadA.iss} vs ${payloadB.iss}`);
}
if (typeof payloadA.iss !== "string" || payloadA.iss.length === 0) {
  fatal(`tokens missing issuer (iss) claim`);
}
ok(`tokens share issuer (iss=${payloadA.iss})`);

console.log("\nlivekit smoke: PASS");
console.log(
  `\nNote: this run did not actually open a websocket. To fully validate the\n` +
    `      pane, run \`npm run dev\`, open the workbench in two tabs, mint\n` +
    `      tokens for distinct identities in the same room id, and click\n` +
    `      Connect on each. Both tiles should appear and chat / transcript\n` +
    `      messages should round-trip with the right reliability.`,
);
