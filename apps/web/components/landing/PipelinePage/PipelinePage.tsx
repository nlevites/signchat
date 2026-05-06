import {
  ArrowRight,
  Broadcast,
  GithubLogo,
  Lightning,
  PaperPlaneTilt,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./pipeline-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const BLOB = `${REPO_URL}/blob/main`;
const PACKAGES_URL = `${REPO_URL}/tree/main/packages`;
const ARCH_URL = `${BLOB}/ARCHITECTURE.md`;
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing"] as const;

interface CodeRef { label: string; path?: string; }
interface Stage { title: string; desc: React.ReactNode; refs: CodeRef[]; }

const STAGES: Stage[] = [
  {
    title: "Camera → MediaPipe landmarks",
    desc: <>The signer's webcam stream is sent to MediaPipe Tasks Vision (face, gesture, pose) and reduced to per-frame landmarks. Loaders live in the small <code>@signchat/sign-pipeline</code> package; the per-frame runner is in <code>@signchat/runtime-browser</code>.</>,
    refs: [
      { label: "packages/sign-pipeline/src/mediapipe.ts", path: `${BLOB}/packages/sign-pipeline/src/mediapipe.ts` },
      { label: "packages/runtime-browser/src/sign-pipeline/mediapipe-runner.ts", path: `${BLOB}/packages/runtime-browser/src/sign-pipeline/mediapipe-runner.ts` },
    ],
  },
  {
    title: "Landmarks → ONNX classifier → top-K",
    desc: <>A 48-frame ring of landmarks is fed into the ONNX classifier every ~500&nbsp;ms. Softmax over 250 classes; two known-noisy labels are zeroed; the top-3 are emitted as <code>ClassifierResult</code>s.</>,
    refs: [
      { label: "packages/sign-pipeline/src/onnx.ts", path: `${BLOB}/packages/sign-pipeline/src/onnx.ts` },
      { label: "packages/runtime-browser/src/sign-pipeline/mediapipe-onnx-classifier.ts", path: `${BLOB}/packages/runtime-browser/src/sign-pipeline/mediapipe-onnx-classifier.ts` },
    ],
  },
  {
    title: "Token admission (stable / band)",
    desc: <>Recognized labels only enter the <code>SignBuffer</code> if they're either consistently top-1 across <code>STABILITY_TICKS</code> ticks (<em>stable</em>) or top-1 with a credible top-2 contender (<em>band</em>). This is the dropout filter against jittery single-tick predictions.</>,
    refs: [
      { label: "packages/sign-pipeline/src/admit.ts", path: `${BLOB}/packages/sign-pipeline/src/admit.ts` },
      { label: "packages/runtime-browser/src/mode-controller/mode-controller.ts", path: `${BLOB}/packages/runtime-browser/src/mode-controller/mode-controller.ts` },
    ],
  },
  {
    title: "Sentence reconstruction via OpenRouter",
    desc: <>When the signer pauses, the buffered tokens plus recent hearing captions become a structured prompt. The browser POSTs directly to OpenRouter — no Vercel relay — with a JSON-schema response format constraining the model to <code>{"{ sentence, confidence, … }"}</code>.</>,
    refs: [
      { label: "packages/prompts/src/build-request.ts", path: `${BLOB}/packages/prompts/src/build-request.ts` },
      { label: "packages/runtime-browser/src/openrouter/client.ts", path: `${BLOB}/packages/runtime-browser/src/openrouter/client.ts` },
    ],
  },
  {
    title: "JSON parse + schema validation",
    desc: <>The model's response is parsed and validated against a Zod schema. Any malformed payload throws a <code>ReconstructionParseError</code> — there's no "fallback voice"; an error stays loud so the signer knows the turn failed.</>,
    refs: [
      { label: "packages/prompts/src/parse-response.ts", path: `${BLOB}/packages/prompts/src/parse-response.ts` },
    ],
  },
  {
    title: "Auto / proofread review",
    desc: <>The reconstructed sentence enters the mode controller's <em>preview</em> state. In auto mode it advances to <em>speaking</em> after a configurable silence; in proofread mode the signer must explicitly Approve, Edit, Re-sign, or Discard.</>,
    refs: [
      { label: "packages/runtime-browser/src/mode-controller/mode-controller.ts", path: `${BLOB}/packages/runtime-browser/src/mode-controller/mode-controller.ts` },
    ],
  },
  {
    title: "ElevenLabs streaming TTS over WSS",
    desc: <>The approved sentence is streamed sentence-at-a-time to ElevenLabs Flash v2.5 over a WebSocket. Returned 24&nbsp;kHz PCM is decoded and mixed with the user's mic in Web Audio and published as a single LiveKit <code>signchat-voice</code> track that the hearing peer subscribes to like any other call audio.</>,
    refs: [
      { label: "packages/runtime-browser/src/elevenlabs/streaming.ts", path: `${BLOB}/packages/runtime-browser/src/elevenlabs/streaming.ts` },
      { label: "ARCHITECTURE.md §8 — signchat-voice", path: `${ARCH_URL}#8-audio-pipeline--signchat-voice` },
    ],
  },
];

interface PackageBox { name: string; role: string; body: React.ReactNode; }
const PACKAGES: PackageBox[] = [
  {
    name: "@signchat/sign-pipeline",
    role: "Vision + ONNX + admit",
    body: <>Tiny shared package for loading MediaPipe and onnxruntime-web, fetching the vocabulary, and the pure <code>admitToken</code> function used by the production mode controller.</>,
  },
  {
    name: "@signchat/prompts",
    role: "Prompts and parsing",
    body: <>The frozen <code>LEAN_OPTIONS_SYSTEM</code> prompt, the request builder that formats top-K tokens and dialog history, and the Zod-backed response parser.</>,
  },
  {
    name: "@signchat/runtime-browser",
    role: "Network + audio + FSM",
    body: <>OpenRouter HTTP client, ElevenLabs WSS streaming, the mode-controller finite state machine, the sign-classifier orchestration, and the Web Audio graph that publishes the <code>signchat-voice</code> track.</>,
  },
];


export function PipelinePage() {
  return (
    <>
      <div className={s.root}>
        <header className={s.header}>
          <div className={s.headerInner}>
            <Nav logo={<Logo size={84} wordmarkSize={37} surface="overlay" />} links={NAV_LINKS} />
          </div>
        </header>

        <section className={s.hero}>
          <div className={s.heroInner}>
            <span className={s.eyebrow}>
              <span className={s.eyebrowDot} aria-hidden />
              Sign Pipeline
            </span>
            <h1 className={s.headline}>From sign tokens to fluent voice — under a second.</h1>
            <p className={s.subheadline}>
              The Signchat pipeline is seven stages, three packages, and zero relay servers.
              Camera frames stay on the device; tokens and audio go directly from the browser to
              OpenRouter and ElevenLabs. Target: sign-end to first audible byte at p50 ~0.6 s,
              p95 ~0.9 s.
            </p>
            <div className={s.ctaRow}>
              <a className={s.ctaPrimary} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Try a call
              </a>
              <a className={s.ctaSecondary} href={PACKAGES_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                Read the source
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>3 packages</span>
              <span>7 stages</span>
              <span>0 relays</span>
            </div>
          </div>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>The seven stages</span>
                <h2 className={s.sectionHeading}>How a sign becomes a sentence becomes a voice.</h2>
                <p className={s.sectionLede}>
                  Each stage is a small file you can read in one sitting. The whole turn fits inside
                  a single browser tab — there is no Signchat backend on the per-turn path.
                </p>
              </header>
              <ol className={s.timeline}>
                {STAGES.map((stage, idx) => (
                  <li key={stage.title} className={s.timelineRow}>
                    <span className={s.timelineNumber} aria-hidden>{idx + 1}</span>
                    <div className={s.timelineBody}>
                      <h3 className={s.timelineTitle}>{stage.title}</h3>
                      <p className={s.timelineDesc}>{stage.desc}</p>
                      <div className={s.timelineCodeLine}>
                        {stage.refs.map((ref, i) => (
                          <span key={ref.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {i > 0 ? <span aria-hidden>·</span> : null}
                            {ref.path ? (
                              <a className={s.codeRef} href={ref.path} target="_blank" rel="noreferrer">{ref.label}</a>
                            ) : (
                              <code className={s.codeRef}>{ref.label}</code>
                            )}
                          </span>
                        ))}
                      </div>
                    </div>
                  </li>
                ))}
              </ol>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Where each stage lives</span>
                <h2 className={s.sectionHeading}>Three packages, one product.</h2>
                <p className={s.sectionLede}>
                  The pipeline is split across three workspace packages so the heavy bits (network,
                  audio, FSM) can be reused by the{" "}
                  <a href="/bridge" style={{ color: "#714cb6", textDecoration: "none", borderBottom: "1px solid currentColor" }}>Bridge</a>{" "}
                  Electron app without dragging the web UI along.
                </p>
              </header>
              <div className={s.packageMap}>
                {PACKAGES.map((pkg) => (
                  <article key={pkg.name} className={s.pkgCard}>
                    <span className={s.pkgName}>{pkg.name}</span>
                    <h3 className={s.pkgRole}>{pkg.role}</h3>
                    <p className={s.pkgBody}>{pkg.body}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Browser-direct, by design</span>
                <h2 className={s.sectionHeading}>No relay, no WSS gateway, no server-side TTS.</h2>
              </header>
              <div className={s.claim}>
                <p className={s.claimQuote}>
                  &ldquo;LiveKit Cloud, OpenRouter, and ElevenLabs handle every per-turn data path.
                  Vercel mints credentials — it&rsquo;s not on the per-turn path.&rdquo;
                </p>
                <p className={s.claimAttrib}>— <a href={`${ARCH_URL}#1-overview`} target="_blank" rel="noreferrer">ARCHITECTURE.md §1</a></p>
                <div className={s.badgeRow}>
                  <span className={s.badge}><Broadcast size={11} weight="bold" /> No Signchat relay</span>
                  <span className={s.badge}><Broadcast size={11} weight="bold" /> No WSS gateway</span>
                  <span className={s.badge}><Broadcast size={11} weight="bold" /> No server-side TTS</span>
                </div>
              </div>
            </div>

            <div className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Measured latency</span>
                <h2 className={s.sectionHeading}>Reconstruction latency, by model.</h2>
                <p className={s.sectionLede}>
                  Numbers from the latest in-repo sweep (
                  <a href={`${BLOB}/prompt-tester-service/charts/RESULTS.md`} target="_blank" rel="noreferrer" style={{ color: "#714cb6", textDecoration: "none", borderBottom: "1px solid currentColor" }}>
                    prompt-tester-service / RESULTS.md
                  </a>
                  ): 10 models × 399 scenarios = 3,990 OpenRouter calls. The numbers below are for
                  the model call only — not the full sign-end → audible-byte path. Add ~300–500 ms
                  for ElevenLabs TTS + audio mixing.
                </p>
              </header>
              <div className={s.latencyChart}>
                <img
                  src="/charts/latency-vs-score.png"
                  alt="Latency vs overall score scatter plot — each dot is one model across 399 cases. Up and to the left is best. gemini-3.1-flash-lite-preview leads on composite quality; gpt-5.4-nano and gpt-5.4 are the fastest. llama-4-maverick dominates on raw speed. claude-haiku and command-a are excluded from real-time use due to high timeout rates."
                  width={1024}
                  height={728}
                  style={{ width: "100%", height: "auto", display: "block" }}
                />
              </div>
              <p className={s.latencyCaption}>
                Each dot is one model across 399 cases. Up and to the left is best. Two models
                (claude-haiku-latest, command-a) have high timeout rates and are excluded from
                real-time use. Full methodology in the{" "}
                <a href={`${BLOB}/prompt-tester-service/charts/RESULTS.md`} target="_blank" rel="noreferrer">
                  RESULTS.md
                </a>.
              </p>
            </div>

            <div className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <Lightning size={22} weight="fill" />
              </span>
              <h2 className={s.outroHeading}>Watch the pipeline run end-to-end.</h2>
              <p className={s.outroBody}>
                Open a call and toggle the Debug pane to see classifier ticks, admitted tokens,
                OpenRouter latency, and TTS bytes in real time.
              </p>
              <a className={s.outroCta} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Open a call
                <ArrowRight size={16} weight="bold" />
              </a>
              <a href={PACKAGES_URL} target="_blank" rel="noreferrer" style={{ marginTop: 4, fontSize: 13, color: "#7d7789", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <GithubLogo size={14} weight="fill" />
                Or browse the packages →
              </a>
            </div>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}

export default PipelinePage;
