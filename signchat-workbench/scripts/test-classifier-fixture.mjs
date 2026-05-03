// Node-side smoke for the asl-signs ONNX classifier.
//
// Why: catch "wrong file / wrong shape / wrong labels" before any browser /
// MediaPipe work. Runs in <1s and exits non-zero on any inconsistency.
//
// What it verifies:
//   1. public/models/asl-signs/sign_to_prediction_index_map.json loads, has
//      250 entries, indices are 0..249 with no gaps.
//   2. public/models/asl-signs/asl-signs.onnx loads via onnxruntime-node.
//   3. The model accepts a (T=8, 543, 3) all-zeros tensor and returns 250
//      finite logits.
//   4. softmax(logits).sum() ~= 1.0.
//
// Usage (from signchat-workbench/):
//   npm run smoke:classifier
//   # or
//   node scripts/test-classifier-fixture.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as ort from "onnxruntime-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MODEL_PATH = join(ROOT, "public", "models", "asl-signs", "asl-signs.onnx");
const LABELS_PATH = join(
  ROOT,
  "public",
  "models",
  "asl-signs",
  "sign_to_prediction_index_map.json",
);

function fatal(message) {
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

function ok(message) {
  console.log(`OK    ${message}`);
}

// ---- 1. labels --------------------------------------------------------------

let raw;
try {
  raw = JSON.parse(readFileSync(LABELS_PATH, "utf8"));
} catch (e) {
  fatal(`could not read ${LABELS_PATH}: ${e.message}`);
}
if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
  fatal("sign_to_prediction_index_map.json: expected JSON object");
}
const entries = Object.entries(raw);
if (entries.length !== 250) {
  fatal(`expected 250 labels, got ${entries.length}`);
}
const indices = new Set();
let maxIdx = -1;
for (const [name, idx] of entries) {
  if (typeof idx !== "number" || !Number.isInteger(idx) || idx < 0 || idx > 249) {
    fatal(`label "${name}" -> ${idx}: out of range [0, 249]`);
  }
  if (indices.has(idx)) {
    fatal(`label "${name}" reuses index ${idx}`);
  }
  indices.add(idx);
  if (idx > maxIdx) maxIdx = idx;
}
if (indices.size !== 250 || maxIdx !== 249) {
  fatal(`label index set incomplete: size=${indices.size} max=${maxIdx}`);
}
ok(`labels: 250 entries, indices 0..249, no gaps or dupes`);

// ---- 2. session -------------------------------------------------------------

let session;
try {
  session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ["cpu"],
    graphOptimizationLevel: "all",
  });
} catch (e) {
  fatal(`InferenceSession.create failed: ${e.message ?? e}`);
}
const inputName = session.inputNames[0];
const outputName = session.outputNames[0];
if (!inputName || !outputName) {
  fatal(`unexpected session shape: inputs=${session.inputNames} outputs=${session.outputNames}`);
}
ok(`session: input="${inputName}" output="${outputName}"`);

// ---- 3. all-zeros forward ---------------------------------------------------

const T = 8;
const flat = new Float32Array(T * 543 * 3);
const tensor = new ort.Tensor("float32", flat, [T, 543, 3]);
let outputs;
const startNs = process.hrtime.bigint();
try {
  outputs = await session.run({ [inputName]: tensor });
} catch (e) {
  fatal(`session.run failed: ${e.message ?? e}`);
}
const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1_000_000;
const logitsTensor = outputs[outputName];
if (!logitsTensor) {
  fatal(`output "${outputName}" missing from result`);
}
if (logitsTensor.dims.length !== 1 || logitsTensor.dims[0] !== 250) {
  fatal(`unexpected output dims: ${JSON.stringify(logitsTensor.dims)} (want [250])`);
}
const logits = logitsTensor.data;
if (logits.length !== 250) {
  fatal(`unexpected output length: ${logits.length}`);
}
let nonFinite = 0;
let min = Infinity;
let max = -Infinity;
for (let i = 0; i < logits.length; i++) {
  const v = logits[i];
  if (!Number.isFinite(v)) nonFinite++;
  if (v < min) min = v;
  if (v > max) max = v;
}
if (nonFinite > 0) {
  fatal(`logits contain ${nonFinite} non-finite values`);
}
ok(
  `forward (T=${T}): 250 finite logits in [${min.toFixed(3)}, ${max.toFixed(3)}], ${elapsedMs.toFixed(1)}ms`,
);

// ---- 4. softmax sums to 1 ---------------------------------------------------

let smaxSum = 0;
{
  let m = -Infinity;
  for (let i = 0; i < logits.length; i++) if (logits[i] > m) m = logits[i];
  let s = 0;
  for (let i = 0; i < logits.length; i++) s += Math.exp(logits[i] - m);
  smaxSum = 0;
  for (let i = 0; i < logits.length; i++) smaxSum += Math.exp(logits[i] - m) / s;
}
if (Math.abs(smaxSum - 1) > 1e-4) {
  fatal(`softmax sum=${smaxSum.toFixed(6)} != 1`);
}
ok(`softmax sum = ${smaxSum.toFixed(6)}`);

// ---- 5. top-3 sanity --------------------------------------------------------

const indexToLabel = new Array(250).fill("?");
for (const [name, idx] of entries) indexToLabel[idx] = name;
const top3 = [];
for (let i = 0; i < logits.length; i++) {
  const v = logits[i];
  if (top3.length < 3) {
    top3.push({ idx: i, v });
    top3.sort((a, b) => b.v - a.v);
  } else if (v > top3[2].v) {
    top3.pop();
    top3.push({ idx: i, v });
    top3.sort((a, b) => b.v - a.v);
  }
}
const topStr = top3
  .map((t) => `${indexToLabel[t.idx]}(${t.v.toFixed(3)})`)
  .join(" ");
ok(`top-3 on all-zero input: ${topStr}`);

console.log("\nclassifier fixture: PASS");
