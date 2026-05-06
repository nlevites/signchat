import {
  ArrowRight,
  ArrowsClockwise,
  Books,
  Cpu,
  GithubLogo,
  HandWaving,
  Lock,
  PaperPlaneTilt,
  Stack,
} from "@phosphor-icons/react/dist/ssr";
import { Logo } from "@/components/ui/Logo";
import { Reveal, RevealGroup } from "@/components/ui/Reveal";
import { Footer } from "@/components/landing/Footer";
import { Nav } from "@/components/landing/HeroHeader/Nav";
import s from "./classifier-page.module.css";

const REPO_URL = "https://github.com/nlevites/signchat";
const MODEL_DIR_URL = `${REPO_URL}/tree/main/asl-classifier-model`;
const MODEL_README_URL = `${REPO_URL}/blob/main/asl-classifier-model/README.md`;
const VOCAB_FILE_URL = `${REPO_URL}/blob/main/asl-classifier-model/data/vocab/kaggle_islr.json`;
const ONNX_SESSION_URL = `${REPO_URL}/blob/main/packages/runtime-browser/src/sign-pipeline/onnx-session.ts`;
const NAV_LINKS = ["Product", "Enterprise", "Education", "Pricing", "Contact"] as const;

interface SpecCard { label: string; value: string; detail: string; }
const SPECS: SpecCard[] = [
  { label: "Model class",  value: "Conv1D + Transformer", detail: "Kaggle ISLR-derived recipe" },
  { label: "Parameters",   value: "~1.7M",                detail: "fits Kaggle 40 MB cap" },
  { label: "Vocabulary",   value: "250 signs",            detail: "PopSign / Kaggle ISLR" },
  { label: "Runtime",      value: "ONNX · WASM",          detail: "onnxruntime-web 1.20.1" },
];

interface RuntimeFeature { icon: React.ReactNode; title: string; body: React.ReactNode; }
const RUNTIME_FEATURES: RuntimeFeature[] = [
  {
    icon: <Cpu size={20} weight="regular" />,
    title: "ONNX in WebAssembly",
    body: <>We load <code>onnxruntime-web@1.20.1</code> from a CDN and run the WASM execution provider only — no GPU required, no native install. See <a href={ONNX_SESSION_URL} target="_blank" rel="noreferrer">onnx-session.ts</a>.</>,
  },
  {
    icon: <ArrowsClockwise size={20} weight="regular" />,
    title: "Sliding 48-frame window",
    body: <>The classifier ticks every ~500 ms over the most recent 48 MediaPipe frames and emits the top-3 labels with confidences. Defaults live in <code>DEFAULT_CLASSIFIER_CONFIG</code> in <code>mediapipe-onnx-classifier.ts</code>.</>,
  },
  {
    icon: <Lock size={20} weight="regular" />,
    title: "Camera frames stay local",
    body: <>Both MediaPipe Holistic and the ONNX classifier execute in your browser tab. Only the recognized sign tokens — short strings with floats — ever leave the device on the per-turn data path.</>,
  },
];

const VOCAB_SAMPLE = [
  "TV", "after", "airplane", "all", "alligator", "animal",
  "another", "any", "apple", "arm", "aunt", "awake",
  "backyard", "bad", "balloon", "bath", "because", "bed",
];

interface ReproItem { text: React.ReactNode; }
const REPRO_ITEMS: ReproItem[] = [
  { text: <>Full training source under <code>asl-classifier-model/</code> — model, preprocessing, augmentations, eval.</> },
  { text: <>Reproducible recipes in <code>configs/base.yaml</code> + <code>configs/pretrain_phase1_kaggle.yaml</code> (200 epochs, AdamW, OneCycleLR cosine, AWP from epoch 15).</> },
  { text: <>Signer-disjoint splits in <code>data/splits/kaggle_islr.json</code> (13 train / 4 val / 4 held-out) so eval doesn't leak signers.</> },
  { text: <><code>Makefile</code> targets for smoke (5 epochs), full train, and eval. RunPod scripts under <code>scripts/</code> provision an H200 end-to-end.</> },
  { text: <>Per-run benchmark log in <code>experiments.csv</code> — top-1 / top-5 accuracy, parameter count, inference latency.</> },
  { text: <>CPU-only unit tests under <code>tests/</code> exercised by <code>make test</code>.</> },
];

export function ClassifierPage() {
  return (
    <>
      <div className={s.root}>
        <header className={s.header}>
          <div className={s.headerInner}>
            <Nav logo={<Logo size={84} wordmarkSize={37} surface="overlay" />} links={NAV_LINKS} />
          </div>
        </header>

        <section className={s.hero}>
          <div className={s.heroBg} aria-hidden>
            <video autoPlay muted loop playsInline preload="metadata">
              <source src="/hero-header/hero-bg.mp4" type="video/mp4" />
            </video>
          </div>
          <RevealGroup className={s.heroInner}>
            <span className={s.eyebrow}>
              <span className={s.eyebrowDot} aria-hidden />
              ASL Classifier
            </span>
            <h1 className={s.headline}>A custom ASL classifier, in your browser.</h1>
            <p className={s.subheadline}>
              A ~1.7-million-parameter Conv1D-Transformer hybrid trained on Google Kaggle's
              <em> asl-signs</em> (PopSign 250) competition, served as ONNX and run on WebAssembly.
              No model server, no vendor inference API.
            </p>
            <div className={s.ctaRow}>
              <a className={s.ctaPrimary} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Try it now
              </a>
              <a className={s.ctaSecondary} href={MODEL_DIR_URL} target="_blank" rel="noreferrer">
                <GithubLogo size={18} weight="fill" />
                View the model
              </a>
            </div>
            <div className={s.heroMeta}>
              <span>Trained on Kaggle ISLR</span>
              <span>200 epochs on a single H200</span>
              <span>WASM execution provider</span>
            </div>
          </RevealGroup>
        </section>
      </div>

      <div className="sc-branded-frame">
        <section className={s.body}>
          <div className={s.bodyInner}>
            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>What it is</span>
                <h2 className={s.sectionHeading}>A small, fast, landmark-only classifier.</h2>
                <p className={s.sectionLede}>
                  The model alternates causal Conv1D blocks and Transformer blocks over MediaPipe
                  Holistic landmarks, kept under the 40 MB TFLite cap that turned out to be the
                  right capacity for landmark-only ISLR.
                </p>
              </header>
              <div className={s.specStrip}>
                {SPECS.map((spec) => (
                  <div key={spec.label} className={s.specCard}>
                    <span className={s.specLabel}>{spec.label}</span>
                    <span className={s.specValue}>{spec.value}</span>
                    <span className={s.specDetail}>{spec.detail}</span>
                  </div>
                ))}
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>How it runs</span>
                <h2 className={s.sectionHeading}>Loaded once, ticked every half-second.</h2>
                <p className={s.sectionLede}>
                  The classifier lives at{" "}
                  <code style={{ fontFamily: 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace', fontSize: 14, background: "#f4f0fc", color: "#714cb6", padding: "1px 6px", borderRadius: 4 }}>
                    /models/asl-signs/asl-signs.onnx
                  </code>{" "}
                  in the public folder. The browser fetches it once, caches it, and runs WASM
                  inference on every meeting.
                </p>
              </header>
              <ul className={s.features}>
                {RUNTIME_FEATURES.map((f) => (
                  <li key={f.title}>
                    <span className={s.featureIcon} aria-hidden>{f.icon}</span>
                    <h3 className={s.featureTitle}>{f.title}</h3>
                    <p className={s.featureBody}>{f.body}</p>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Inputs and outputs</span>
                <h2 className={s.sectionHeading}>Landmarks in, ranked sign labels out.</h2>
                <p className={s.sectionLede}>
                  The browser assembles MediaPipe Holistic landmarks into a Float32 tensor, runs the
                  ONNX model, applies softmax, and picks the top-K. Two blocked label indices
                  (<code>giraffe</code> and <code>drop</code>) are zeroed out in production because
                  they over-fire on idle hands.
                </p>
              </header>
              <div className={s.io}>
                <div className={s.ioCard}>
                  <span className={s.ioLabel}><ArrowRight size={11} weight="bold" /> Input</span>
                  <pre className={s.ioCode}>{`Float32Tensor[T, 543, 3]\n  T = up to 48 frames (sliding window)\n  543 = MediaPipe Holistic landmarks\n  3   = (x, y, z) per landmark`}</pre>
                  <p className={s.ioCaption}>
                    The classifier ticks every ~500 ms once the ring buffer has at least 8 frames.
                    Older frames are dropped as new ones arrive.
                  </p>
                </div>
                <div className={s.ioCard}>
                  <span className={s.ioLabel}><ArrowRight size={11} weight="bold" /> Output</span>
                  <pre className={s.ioCode}>{`Float32[250]                  // raw logits\n  -> softmax\n  -> blocked labels zeroed\n  -> top-3 -> ClassifierResult\n     { label: string,\n       score: number /* 0..1 */ }`}</pre>
                  <p className={s.ioCaption}>
                    Downstream, the mode controller in <code>@signchat/runtime-browser</code> admits
                    a label as a <em>stable</em> or <em>band</em> token when it stays consistent
                    across ticks.
                  </p>
                </div>
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Vocabulary</span>
                <h2 className={s.sectionHeading}>250 signs from the PopSign corpus.</h2>
                <p className={s.sectionLede}>
                  Glosses follow Kaggle's canonical lowercase form. Aliases in{" "}
                  <code>src/data/gloss_aliases.expand_aliases</code> map each one to ASL Citizen /
                  WLASL conventions for cross-dataset pretraining.
                </p>
              </header>
              <div className={s.vocabWrap}>
                <ul className={s.vocabChips}>
                  {VOCAB_SAMPLE.map((sign) => (
                    <li key={sign} className={s.vocabChip}>{sign}</li>
                  ))}
                </ul>
                <div className={s.vocabFooter}>
                  <span>First 18 of 250 signs.</span>
                  <a href={VOCAB_FILE_URL} target="_blank" rel="noreferrer">See all 250 →</a>
                </div>
              </div>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Trained on</span>
                <h2 className={s.sectionHeading}>Google Kaggle <em>asl-signs</em> (PopSign 250).</h2>
                <p className={s.sectionLede}>
                  Trained on the Kaggle Isolated Sign Language Recognition competition dataset —
                  PopSign 250 — for 200 epochs on a single H200 with bf16 + XLA, AdamW, OneCycleLR
                  cosine, and Adversarial Weight Perturbation from epoch 15. Splits are
                  signer-disjoint (13 train / 4 val / 4 held-out) so eval numbers reflect
                  performance on signers the model has never seen.
                </p>
              </header>
            </Reveal>

            <Reveal className={s.section}>
              <header className={s.sectionHead}>
                <span className={s.sectionEyebrow}>Open and reproducible</span>
                <h2 className={s.sectionHeading}>Every recipe, script, and benchmark is in the repo.</h2>
                <p className={s.sectionLede}>
                  Nothing about the classifier is hidden. Read the README, audit the configs, run{" "}
                  <code>make eval</code> — or train your own checkpoint and swap it into{" "}
                  <code>apps/web</code>.
                </p>
              </header>
              <ul className={s.bullets}>
                {REPRO_ITEMS.map((item, idx) => (
                  <li key={idx}>
                    <span className={s.bulletDot} aria-hidden><Stack size={11} weight="bold" /></span>
                    <span>{item.text}</span>
                  </li>
                ))}
              </ul>
            </Reveal>

            <Reveal className={s.outro}>
              <span aria-hidden style={{ display: "inline-grid", placeItems: "center", width: 44, height: 44, borderRadius: 10, background: "#d4c7ff", color: "#714cb6" }}>
                <HandWaving size={22} weight="regular" />
              </span>
              <h2 className={s.outroHeading}>See the classifier in a real call.</h2>
              <p className={s.outroBody}>
                Open the app, allow your camera, and start signing. The classifier loads in the
                background while you're in the lobby — by the time you join, it's warm.
              </p>
              <a className={s.outroCta} href="/start">
                <PaperPlaneTilt size={18} weight="bold" />
                Try the classifier
                <ArrowRight size={16} weight="bold" />
              </a>
              <a href={MODEL_README_URL} target="_blank" rel="noreferrer" style={{ marginTop: 4, fontSize: 13, color: "#7d7789", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                <Books size={14} weight="regular" />
                Or read the training README →
              </a>
            </Reveal>
          </div>
        </section>
      </div>

      <Footer />
    </>
  );
}

export default ClassifierPage;
