"""Live webcam ASL classification demo with the contract-layer state machine.

Pipeline per frame:
    webcam -> MediaPipe Holistic -> rolling buffer of last `buffer_frames`
              -> every `inference_every` frames:
                  motion_energy = compute_motion_energy(buffer)
                  if motion_energy < motion_idle_thresh AND no in-flight commit:
                      idle short-circuit; no model call this tick
                  else:
                      preprocess -> model(logits) -> logits/T (calibrated)
                                 -> probs -> ContractStateMachine.update(...)
              -> emit TickEvent via JsonlSink (--llm-bridge)
              -> render OpenCV overlay (committed history, top-K bars, FPS)

What changed vs the v1 demo:
  * Inline sentence-builder replaced by src.contract.ContractStateMachine
    (rolling stability + edge-triggered commit + idle/low-conf release).
  * Temperature scaling: divide logits by T from the checkpoint's
    temperature.json (if present) BEFORE softmax. Honest probabilities for
    the LLM consumer; argmax/top-1 unchanged.
  * Motion-energy idle short-circuit: skip the model entirely when hands
    are at rest, save GPU and stop spamming the LLM with garbage windows.
  * JSONL emit via src.llm_bridge: one event per inference tick to stdout
    or a .jsonl file, consumable by any LLM client doing live composition.
  * Knobs (buffer_frames, inference_every, oov_gate, stability_k, etc.) all
    live in configs/contract.yaml — no Python edits needed to tune cadence.

Strict checkpoint loading: a `--checkpoint` directory MUST contain a
`vocab.json` sidecar written by src/train.py. The sidecar pins the model
architecture + the exact label-index -> gloss mapping the model was trained
on. Optional companion `temperature.json` (written by src/calibrate.py)
applies temperature scaling at inference time.

Usage:
    python -m src.realtime_demo --checkpoint pretrained/phase1_broad/
    python -m src.realtime_demo --checkpoint <ckpt> --llm-bridge stdout
    python -m src.realtime_demo --checkpoint <ckpt> --llm-bridge jsonl-file:/tmp/run.jsonl
    python -m src.realtime_demo --tflite path/to/model.tflite \
        --tflite-vocab path/to/vocab.json
"""

from __future__ import annotations

import argparse
import json
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np
import tensorflow as tf
import yaml

from .contract import (
    ContractConfig,
    ContractStateMachine,
    TickEvent,
    compute_motion_energy,
)
from .data.mediapipe_runner import holistic_session, landmarks_from_result
from .llm_bridge import JsonlSink
from .model import build_classifier
from .preprocessing import preprocess_numpy

DEFAULT_CONTRACT_CONFIG = "configs/contract.yaml"
TOP_K_DISPLAY = 3
SENTENCE_RESET_S = 1.5
MAX_SENTENCE_TOKENS = 8


def _load_sidecar(ckpt_dir: Path) -> dict:
    """Read and validate the vocab.json sidecar."""
    sidecar_path = ckpt_dir / "vocab.json"
    if not sidecar_path.exists():
        raise FileNotFoundError(
            f"No vocab.json sidecar at {sidecar_path}.\n"
            "Demo refuses to load checkpoints without a sidecar; this prevents "
            "the failure mode where the demo silently picks a vocab from the "
            "YAML config that doesn't match the model's softmax. Re-train with "
            "the current src/train.py to produce one."
        )
    sc = json.loads(sidecar_path.read_text())
    for k in ("vocab", "n_classes", "data", "model"):
        if k not in sc:
            raise ValueError(f"vocab sidecar at {sidecar_path} missing key {k!r}")
    if len(sc["vocab"]) != int(sc["n_classes"]):
        raise ValueError(
            f"vocab sidecar inconsistency: {len(sc['vocab'])} vocab entries vs "
            f"n_classes={sc['n_classes']} at {sidecar_path}"
        )
    return sc


def _load_temperature(ckpt_dir: Path | None, fallback_T: float = 1.0) -> float:
    """Read temperature.json next to the checkpoint, if present.

    Returns the scalar T to divide logits by before softmax. ``fallback_T=1.0``
    means no scaling (identity). Written by src/calibrate.py.
    """
    if ckpt_dir is None:
        return fallback_T
    tjson = ckpt_dir / "temperature.json"
    if not tjson.exists():
        return fallback_T
    try:
        data = json.loads(tjson.read_text())
        T = float(data.get("T", fallback_T))
        if T <= 0:
            print(f"[demo] WARN temperature.json has T={T}; using fallback {fallback_T}")
            return fallback_T
        return T
    except Exception as e:
        print(f"[demo] WARN failed to read {tjson}: {e}; using fallback {fallback_T}")
        return fallback_T


def _load_contract_config(path: Path) -> tuple[ContractConfig, dict]:
    """Parse configs/contract.yaml. Returns (ContractConfig, full_dict)."""
    if not path.exists():
        print(f"[demo] WARN {path} missing; using ContractConfig defaults")
        return ContractConfig(), {"contract": {}, "calibration": {"apply": False, "fallback_T": 1.0}}
    full = yaml.safe_load(path.read_text()) or {}
    c = full.get("contract", {}) or {}
    cfg = ContractConfig(
        k=int(c.get("k", 3)),
        oov_gate=float(c.get("oov_gate", 0.4)),
        stability_k=int(c.get("stability_k", 3)),
        release_frames=int(c.get("release_frames", 5)),
        release_prob=float(c.get("release_prob", 0.3)),
        motion_idle_thresh=float(c.get("motion_idle_thresh", 0.05)),
        motion_window=int(c.get("motion_window", 30)),
    )
    return cfg, full


class _Predictor:
    """Wraps either a Keras model or a TFLite Interpreter.

    .predict() returns RAW LOGITS (not softmax). The caller (run loop) is
    responsible for dividing by T and softmaxing, so calibration applies
    consistently across both backends.
    """

    def __init__(self, keras_model=None, tflite_path: str | None = None):
        self.keras = keras_model
        self.tflite = None
        if tflite_path:
            self.tflite = tf.lite.Interpreter(model_path=tflite_path)
            self.tflite.allocate_tensors()
            self.in_details = self.tflite.get_input_details()
            self.out_details = self.tflite.get_output_details()

    def predict(self, feats: np.ndarray, mask: np.ndarray) -> np.ndarray:
        if self.tflite is not None:
            for d in self.in_details:
                if "feature" in d["name"].lower():
                    self.tflite.set_tensor(d["index"], feats[None].astype(np.float32))
                else:
                    self.tflite.set_tensor(d["index"], mask[None].astype(np.bool_))
            self.tflite.invoke()
            return self.tflite.get_tensor(self.out_details[0]["index"])[0]
        return self.keras([feats[None], mask[None]], training=False).numpy()[0]


def _calibrated_softmax(logits: np.ndarray, T: float) -> np.ndarray:
    """Numerically stable softmax(logits / T)."""
    z = logits / max(T, 1e-6)
    z = z - z.max()
    e = np.exp(z)
    return e / e.sum()


def _build_model_from_sidecar(sc: dict) -> tf.keras.Model:
    """Instantiate the architecture exactly as recorded in the sidecar."""
    m = sc["model"]
    d = sc["data"]
    return build_classifier(
        num_classes=int(sc["n_classes"]),
        name=m["name"],
        max_len=int(d["max_len"]),
        n_landmarks=int(d["n_landmarks"]),
        n_channels=int(d.get("n_channels", 6)),
        dim=int(m["dim"]),
        n_blocks=int(m.get("n_blocks", 4)),
        n_heads=int(m.get("n_heads", 4)),
        conv_kernel=int(m.get("conv_kernel", 17)),
        ffn_expansion=int(m.get("ffn_expansion", 4)),
        dropout=0.0,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", default=None,
                        help="path to a checkpoint dir; MUST contain vocab.json sidecar")
    parser.add_argument("--tflite", default=None,
                        help="path to a .tflite file (legacy; bypasses sidecar)")
    parser.add_argument("--tflite-vocab", default=None,
                        help="path to vocab.json sidecar when using --tflite")
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--contract-config", default=DEFAULT_CONTRACT_CONFIG,
                        help=f"path to contract knobs YAML (default: {DEFAULT_CONTRACT_CONFIG})")
    parser.add_argument("--llm-bridge", default="none",
                        help="JSONL sink: 'none' (default; silent), 'stdout', "
                             "'stderr', or 'jsonl-file:<path>' / '<path>.jsonl'")
    parser.add_argument("--no-ui", action="store_true",
                        help="suppress the OpenCV window (headless mode; useful "
                             "when piping --llm-bridge stdout into another script)")
    args = parser.parse_args()

    if args.checkpoint is None and args.tflite is None:
        raise SystemExit("pass --checkpoint or --tflite")

    contract_cfg, full_cfg = _load_contract_config(Path(args.contract_config))
    apply_calibration = bool(full_cfg.get("calibration", {}).get("apply", True))
    fallback_T = float(full_cfg.get("calibration", {}).get("fallback_T", 1.0))
    inference_every = int(full_cfg.get("contract", {}).get("inference_every", 8))
    buffer_frames = int(full_cfg.get("contract", {}).get("buffer_frames", 64))

    if args.checkpoint:
        ckpt_dir = Path(args.checkpoint)
        sc = _load_sidecar(ckpt_dir)
        weights = ckpt_dir / "best.weights.h5"
        sm_dir = ckpt_dir / "saved_model"
        if weights.exists():
            model = _build_model_from_sidecar(sc)
            model.load_weights(str(weights), by_name=True, skip_mismatch=False)
        elif sm_dir.exists():
            model = tf.keras.models.load_model(sm_dir)
        else:
            raise FileNotFoundError(f"no best.weights.h5 or saved_model/ in {ckpt_dir}")
        predictor = _Predictor(keras_model=model)
        T = _load_temperature(ckpt_dir, fallback_T) if apply_calibration else 1.0
    else:
        if args.tflite_vocab is None:
            raise SystemExit("--tflite requires --tflite-vocab pointing at the sidecar")
        sc = _load_sidecar(Path(args.tflite_vocab).parent)
        predictor = _Predictor(tflite_path=args.tflite)
        T = _load_temperature(Path(args.tflite_vocab).parent, fallback_T) \
            if apply_calibration else 1.0

    vocab = sc["vocab"]
    max_len = int(sc["data"]["max_len"])
    n_ch_sidecar = int(sc["data"].get("n_channels", 6))
    use_motion_deltas = bool(sc["data"].get("use_motion_deltas",
                                             n_ch_sidecar >= 6))
    use_acceleration = bool(sc["data"].get("use_acceleration",
                                            n_ch_sidecar == 9))
    print(f"[demo] strict-loaded {len(vocab)} classes from "
          f"{sc.get('experiment_name','?')} (run_id={sc.get('run_id','?')})")
    print(f"[demo] temperature T={T:.4f} ({'applied' if apply_calibration else 'disabled'})")
    print(f"[demo] contract: stability_k={contract_cfg.stability_k} "
          f"oov_gate={contract_cfg.oov_gate} release_frames={contract_cfg.release_frames} "
          f"motion_idle_thresh={contract_cfg.motion_idle_thresh}")
    print(f"[demo] inference_every={inference_every} buffer_frames={buffer_frames}")

    state_machine = ContractStateMachine(vocab, contract_cfg, history_len=MAX_SENTENCE_TOKENS)
    sink = JsonlSink.from_spec(args.llm_bridge)
    if sink is not None:
        print(f"[demo] llm bridge sink: {sink}")

    cap = cv2.VideoCapture(args.device)
    if not cap.isOpened():
        raise RuntimeError(f"could not open webcam {args.device}")

    buf: deque[np.ndarray] = deque(maxlen=buffer_frames)
    frame_idx = 0
    last_event: TickEvent | None = None
    last_committed_t = 0.0
    fps_hist: deque[float] = deque(maxlen=30)
    last_t = time.time()

    try:
        with holistic_session() as holistic:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                frame = cv2.flip(frame, 1)
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                rgb.flags.writeable = False
                result = holistic.process(rgb)
                buf.append(landmarks_from_result(result))

                if frame_idx % inference_every == 0 and len(buf) >= 16:
                    t_ms = int(time.time() * 1000)
                    raw_buf = np.stack(list(buf), axis=0)
                    motion = compute_motion_energy(
                        raw_buf, window=contract_cfg.motion_window)
                    # Idle short-circuit: skip the (expensive) model call when
                    # hands are at rest and no commit is in flight. The state
                    # machine still emits an idle TickEvent so the LLM gets a
                    # heartbeat and the release counter advances.
                    if (motion < contract_cfg.motion_idle_thresh
                            and not state_machine._suppressed_word):  # noqa: SLF001
                        ev = state_machine.update(t_ms=t_ms, probs=None,
                                                   motion_energy=motion)
                    else:
                        feats, mask = preprocess_numpy(
                            raw_buf, max_len=max_len,
                            use_motion_deltas=use_motion_deltas,
                            use_acceleration=use_acceleration)
                        logits = predictor.predict(feats, mask)
                        probs = _calibrated_softmax(logits, T=T)
                        ev = state_machine.update(
                            t_ms=t_ms, probs=probs, logits=logits,
                            motion_energy=motion,
                        )
                    if sink is not None:
                        sink.emit(ev)
                    last_event = ev
                    if ev.committed:
                        last_committed_t = time.time()

                # FPS
                now = time.time()
                fps_hist.append(1.0 / max(1e-6, now - last_t))
                last_t = now
                fps = sum(fps_hist) / len(fps_hist)

                if not args.no_ui:
                    _render_overlay(frame, last_event, state_machine, fps,
                                    last_committed_t)
                    cv2.imshow("realtime_demo", frame)
                    if (cv2.waitKey(1) & 0xFF) == ord("q"):
                        break

                frame_idx += 1
    finally:
        cap.release()
        if not args.no_ui:
            cv2.destroyAllWindows()
        if sink is not None:
            sink.close()


def _render_overlay(frame: np.ndarray, ev: TickEvent | None,
                     sm: ContractStateMachine, fps: float,
                     last_committed_t: float) -> None:
    """Draw the top-banner sentence + top-K bars + FPS counter onto `frame`.

    Sentence resets after SENTENCE_RESET_S of silence (no committed event).
    """
    h, w = frame.shape[:2]

    # Top banner: assembled sentence from committed history. Reset if it's
    # been quiet for SENTENCE_RESET_S.
    cv2.rectangle(frame, (0, 0), (w, 110), (0, 0, 0), -1)
    if last_committed_t and (time.time() - last_committed_t) > SENTENCE_RESET_S:
        # Reset history when the gap exceeds the threshold so the banner clears
        # between sentences. This mutation is intentional; preserves the
        # "ephemeral sentence" UX of the v1 demo.
        sm.reset()
    sent_text = " ".join(sm.committed_words) if sm.committed_words else "..."
    cv2.putText(frame, sent_text, (10, 50),
                cv2.FONT_HERSHEY_SIMPLEX, 1.1, (0, 255, 0), 2)
    cv2.putText(frame, f"fps: {fps:.1f}", (w - 130, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (200, 200, 200), 1)

    if ev is None:
        return

    # Top-K bars
    is_oov = ev.low_conf or ev.idle
    primary_color = (80, 80, 200) if is_oov else (0, 255, 0)
    pad_topk = (ev.top_k + [("-", 0.0, 0.0)] * TOP_K_DISPLAY)[:TOP_K_DISPLAY]
    for rank, (name, p, _logit) in enumerate(pad_topk):
        y = h - 25 - (TOP_K_DISPLAY - 1 - rank) * 28
        display_name = name
        if rank == 0 and is_oov:
            display_name = f"? ({name})" if name not in ("-", "<oov>") else "?"
        cv2.putText(frame, f"{rank+1}. {display_name}", (10, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                    primary_color if rank == 0 else (200, 200, 200), 1)
        bar_w = int(p * (w // 2))
        bar_x = w // 2
        cv2.rectangle(frame, (bar_x, y - 12), (bar_x + bar_w, y - 2),
                      primary_color if rank == 0 else (160, 160, 160), -1)
        cv2.rectangle(frame, (bar_x, y - 12), (bar_x + w // 2, y - 2),
                      (80, 80, 80), 1)
        cv2.putText(frame, f"{p:.2f}", (bar_x + w // 2 + 6, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.45, (200, 200, 200), 1)

    # Status corner: motion energy + stability + commit indicator
    status = (f"motion={ev.motion_energy:.3f}  stab={ev.stability_count}"
              f"{'  COMMIT' if ev.committed else ''}"
              f"{'  IDLE' if ev.idle else ''}")
    cv2.putText(frame, status, (10, h - 25 - TOP_K_DISPLAY * 28 - 5),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (180, 180, 180), 1)


if __name__ == "__main__":
    main()
