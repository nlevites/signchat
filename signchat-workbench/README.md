# SignChat Workbench

Integration test harness for the SignChat Deaf-signer flow. Sibling app to
[`prompt-tester-service/`](../prompt-tester-service/); runs on **port 3020**.

The production app (`apps/web/` per [`ARCHITECTURE.md`](../ARCHITECTURE.md)) is
the eventual home for this code; the workbench exists so that every integration
— LiveKit transport, OpenRouter reconstruction, ElevenLabs streaming TTS, the
Web Audio mixer, the sign classifier — can be exercised independently behind
stable `lib/*` modules **before** the clean UI lands. When the UI is ready,
the modules in this app are copy-paste ready.

## Quick start

```bash
cp .env.example .env
# Fill in LIVEKIT_*, OPENROUTER_MANAGEMENT_API_KEY, ELEVENLABS_*
npm install
npm run dev          # http://localhost:3020
```

Smoke tests for the modules that are wired up today:

```bash
npm run smoke:classifier   # ORT loads asl-signs.onnx, runs (T=8, 543, 3)
npm run smoke:assembly     # landmark-assembly.ts pure-function tests
```

## Tab map

| Tab            | Status                | What it validates                                             |
|----------------|-----------------------|--------------------------------------------------------------- |
| Lobby          | placeholder (Phase 1) | Mints LiveKit JWT + OpenRouter session key + EL signed URL    |
| LiveKit        | placeholder (Phase 2) | Join, publish camera + mic, send/receive RoomDataMessage      |
| OpenRouter     | placeholder (Phase 3) | Browser-direct chat/completions with strict json_schema       |
| ElevenLabs     | placeholder (Phase 4) | Streaming WSS → PCM decode → AudioContext → signchat-voice    |
| **Sign capture** | **live (Phase 5b)** | **MediaPipe Tasks Vision → 250-class asl-signs ONNX → top-3** |
| End-to-end     | placeholder (Phase 6) | Full Deaf turn: capture → LLM → preview → TTS → publish       |
| Whisper        | placeholder (Phase 7) | (deferred) Hearing audio → VAD → transformers.js Whisper      |
| Latency        | live                  | Rolling p50/p95 per stage vs §13 budgets                      |

The bottom drawer is a unified log stream — every `lib/*` module writes to a
shared `LogBus` so cross-pane causality is visible at a glance.

## Architecture decisions baked in

- **Browser-direct calls.** OpenRouter and ElevenLabs are called from the
  browser using credentials minted by `app/api/*` routes. Vercel is never on
  the per-turn data path. Matches [`ARCHITECTURE.md`](../ARCHITECTURE.md) §10–11.
- **No fallbacks.** A failed turn surfaces the §7 error and waits for re-commit.
  No silent retry, no degraded path.
- **`signchat-voice` will be one mixed track.** Mic + TTS combined in a Web
  Audio graph (§8.1); only the mixed `MediaStreamDestination` track is
  published, never raw mic. Lands in Phase 4.
- **AudioContext at 24 kHz.** Matches ElevenLabs `pcm_24000` so no resampling
  happens in the browser (§8.1).
- **Single source of truth for shared types.** `lib/contracts/index.ts` holds
  every cross-module type (`RoomDataMessage`, `SignToken`, `ReconstructionPayload`,
  `Role`). The future `apps/web/` will copy this file unchanged.
- **`onnxruntime-web` is CDN-loaded**, never bundled (§5.4). The
  `new Function("u", "return import(u)")` shim in
  [`lib/sign-pipeline/onnx-session.ts`](lib/sign-pipeline/onnx-session.ts)
  bypasses Turbopack so ort's WASM glue still works.
- **WASM execution provider only.** WebGPU was empirically ~1000× slower for
  this Squeezeformer + dynamic-time-dim workload (§5.4).
- **Kaggle row order for landmarks** — `[Face(468), LHand(21), Pose(33), RHand(21)]`
  with NaN for missing detections. The assembly is the load-bearing function
  that any future bug will land on; covered by `npm run smoke:assembly`.

## Module layout

```
signchat-workbench/
  app/
    layout.tsx, page.tsx, globals.css
    api/
      health/route.ts                            # §10.4
      livekit/token/route.ts                     # planned (Phase 1)
      openrouter/session-key/route.ts            # planned (Phase 1)
      elevenlabs/signed-url/route.ts             # planned (Phase 1)
  lib/
    contracts/index.ts                           # §11 types — single source of truth
    diagnostics/{log-bus,latency-markers}.ts     # cross-cutting LogBus + p50/p95 store
    sign-pipeline/                               # Phase 5b live
      classifier.ts                              # interface Classifier { start, stop, onResult }
      labels.ts                                  # 250-class label map + softmax + topK
      landmark-assembly.ts                       # 3 detector results -> (543, 3) Kaggle row order
      mediapipe-runner.ts                        # FilesetResolver + Face/Hand/Pose landmarkers
      mediapipe-onnx-classifier.ts               # full live pipeline (camera -> ORT -> top-K)
      onnx-session.ts                            # CDN-loaded ort + InferenceSession factory
      model-cache.ts                             # IndexedDB caching of the 21 MB .onnx
      mp-log-filter.ts                           # downgrade MP's INFO console.error noise
    livekit/                                     # planned (Phase 2)
    openrouter/                                  # planned (Phase 3)
    elevenlabs/                                  # planned (Phase 4)
    audio/                                       # planned (Phase 4) — signchat-voice mixer
    prompts/                                     # planned (Phase 3) — frozen winner
    whisper/                                     # planned (Phase 7)
  components/
    panes/*                                      # one per tab
    primitives/                                  # log-stream, camera-preview, topk-bars
  public/
    models/asl-signs/
      asl-signs.onnx                             # 21 MB Kaggle competition export
      sign_to_prediction_index_map.json          # 250-class label map
  scripts/
    test-classifier-fixture.mjs                  # ORT smoke (model load + (T=8, 543, 3) forward)
    test-landmark-assembly.ts                    # pure-function tests for the assembly
```

## Relationship to other parts of the repo

| Sibling                                              | Role                                                          |
|------------------------------------------------------|---------------------------------------------------------------|
| [`../prompt-tester-service/`](../prompt-tester-service/) | Prompt iteration lab (5 strategies, 387 cases, judge scoring) |
| [`../asl-classifier-model/`](../asl-classifier-model/)   | Python ML training for the ASL ONNX model                     |
| (future) `apps/web/`                                 | Production UI built by teammate; copies `lib/*` from here     |

The workbench imports the **frozen winning** prompt from prompt-tester-service
once a strategy emerges as the winner from a sweep. It does not duplicate the
prompt-iteration scaffolding.

## Ports

| App                       | Port |
|---------------------------|------|
| `prompt-tester-service`   | 3010 |
| `signchat-workbench`      | 3020 |
