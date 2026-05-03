// Smoke test for lib/sign-pipeline/landmark-assembly.ts
//
// Pure-function tests, no model load. Runs in <100ms via tsx.
//
// Usage (from signchat-workbench/):
//   npm run smoke:assembly

import {
  assembleFrame,
  countDetectedPoints,
  FrameRingBuffer,
  N_FACE,
  N_LHAND,
  N_TOTAL,
  FRAME_FLOATS,
  FACE_OFFSET,
  LHAND_OFFSET,
  POSE_OFFSET,
  RHAND_OFFSET,
  newFrameBuffer,
  stackWindow,
} from "../lib/sign-pipeline/landmark-assembly";

function fail(msg: string): never {
  console.error("FAIL  " + msg);
  process.exit(1);
}
function ok(msg: string): void {
  console.log("OK    " + msg);
}

if (N_TOTAL !== 543) fail(`N_TOTAL ${N_TOTAL}`);
if (FRAME_FLOATS !== 1629) fail(`FRAME_FLOATS ${FRAME_FLOATS}`);
ok("constants: 543 / 1629");

if (FACE_OFFSET !== 0) fail("FACE_OFFSET");
if (LHAND_OFFSET !== 468) fail("LHAND_OFFSET");
if (POSE_OFFSET !== 489) fail("POSE_OFFSET");
if (RHAND_OFFSET !== 522) fail("RHAND_OFFSET");
ok("offsets: face=0 lh=468 pose=489 rh=522");

// Empty input -> all-NaN frame.
{
  const out = assembleFrame({ face: null, hands: [], pose: null });
  if (out.length !== FRAME_FLOATS) fail("empty length");
  let allNaN = true;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isNaN(out[i] as number)) {
      allNaN = false;
      break;
    }
  }
  if (!allNaN) fail("empty frame should be all NaN");
  if (countDetectedPoints(out) !== 0) fail("countDetectedPoints empty");
  ok("empty input -> all-NaN frame");
}

// Face only, with 478-row Tasks Vision input (truncated to 468).
{
  const face = Array.from({ length: 478 }, (_, i) => ({ x: i / 478, y: 0.5, z: 0.1 }));
  const out = assembleFrame({ face, hands: [], pose: null });
  for (let i = 0; i < N_FACE; i++) {
    const base = (FACE_OFFSET + i) * 3;
    if (!Number.isFinite(out[base] as number)) fail(`face row ${i} x is not finite`);
  }
  for (let i = 0; i < N_LHAND; i++) {
    const base = (LHAND_OFFSET + i) * 3;
    if (Number.isFinite(out[base] as number)) {
      fail(`LHand row ${i} unexpectedly finite`);
    }
  }
  ok("face-only: 468 face rows finite, hands+pose NaN");
}

// Hand handedness mapping.
{
  const lhand = Array.from({ length: 21 }, (_, i) => ({ x: 0.1, y: i / 21, z: 0 }));
  const rhand = Array.from({ length: 21 }, (_, i) => ({ x: 0.9, y: i / 21, z: 0 }));
  const out = assembleFrame({
    face: null,
    pose: null,
    hands: [
      { handedness: "Left", landmarks: lhand },
      { handedness: "Right", landmarks: rhand },
    ],
  });
  const lx = out[LHAND_OFFSET * 3] as number;
  const rx = out[RHAND_OFFSET * 3] as number;
  if (Math.abs(lx - 0.1) > 1e-6) fail(`LHand x mismatch: ${lx}`);
  if (Math.abs(rx - 0.9) > 1e-6) fail(`RHand x mismatch: ${rx}`);
  ok("handedness: Left -> rows 468..488, Right -> 522..542");
}

// Duplicate handedness: prefer higher score.
{
  const lhandLow = Array.from({ length: 21 }, () => ({ x: 0.1, y: 0, z: 0 }));
  const lhandHigh = Array.from({ length: 21 }, () => ({ x: 0.7, y: 0, z: 0 }));
  const out = assembleFrame({
    face: null,
    pose: null,
    hands: [
      { handedness: "Left", landmarks: lhandLow, score: 0.4 },
      { handedness: "Left", landmarks: lhandHigh, score: 0.95 },
    ],
  });
  const lx = out[LHAND_OFFSET * 3] as number;
  if (Math.abs(lx - 0.7) > 1e-6) fail(`dup-handedness should pick high-score, got ${lx}`);
  ok("duplicate handedness: higher-score wins");
}

// stackWindow shape.
{
  const f1 = newFrameBuffer();
  const f2 = newFrameBuffer();
  const w = stackWindow([f1, f2]);
  if (w.length !== 2 * FRAME_FLOATS) fail(`stackWindow length ${w.length}`);
  ok("stackWindow: T frames -> T*1629 floats");
}

// Ring buffer.
{
  const ring = new FrameRingBuffer(3);
  for (let i = 0; i < 5; i++) {
    const f = newFrameBuffer();
    f[0] = i;
    ring.push(f);
  }
  const snap = ring.snapshot();
  if (snap.length !== 3) fail(`ring size ${snap.length}`);
  const a = snap[0]?.[0];
  const b = snap[1]?.[0];
  const c = snap[2]?.[0];
  if (a !== 2 || b !== 3 || c !== 4) {
    fail(`ring snapshot order: ${a},${b},${c}`);
  }
  ok("ring buffer: oldest evicted, snapshot is chronological");
}

console.log("\nlandmark-assembly: PASS");
