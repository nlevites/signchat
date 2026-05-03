import { useSyncExternalStore } from "react";
import {
  createModeController,
  type ModeController,
  type ModeControllerOptions,
  type ModeSnapshot,
} from "./mode-controller";

/**
 * Per-pane controller registry. The Phase 6 pane creates a controller on
 * mount via `acquireController()`, drives it with classifier results, and
 * releases it on unmount via the dispose handle.
 *
 * `useModeSnapshot()` is a `useSyncExternalStore` hook that returns the
 * current controller's snapshot (or an empty placeholder when no
 * controller is active). Pattern matches RoomStore / RoomInbox / LogBus.
 */

const EMPTY_SNAPSHOT: ModeSnapshot = Object.freeze({
  state: "idle",
  mode: "auto",
  buffer: { tokens: [], startedAt: 0, lastAdmitAt: null, epoch: 0 },
  thresholds: {
    top1Threshold: 0.3,
    top2Threshold: 0.1,
    silenceMs: 500,
    inferenceIntervalMs: 200,
    autoStartThreshold: 0.25,
    autoStopThreshold: 0.03,
  },
  preview: null,
  speakingSentence: null,
  error: null,
  enteredStateAt: 0,
  lowConfidenceStartedAt: null,
}) as ModeSnapshot;

class ControllerStoreImpl {
  private controller: ModeController | null = null;
  private cached: ModeSnapshot = EMPTY_SNAPSHOT;
  private unsubscribeController: (() => void) | null = null;
  private subs = new Set<() => void>();

  attach(controller: ModeController): void {
    this.detach();
    this.controller = controller;
    this.cached = controller.snapshot();
    this.unsubscribeController = controller.subscribe(() => {
      if (this.controller) {
        this.cached = this.controller.snapshot();
        this.notify();
      }
    });
    this.notify();
  }

  detach(): void {
    if (this.unsubscribeController) {
      try {
        this.unsubscribeController();
      } catch {
        // ignore
      }
      this.unsubscribeController = null;
    }
    this.controller = null;
    this.cached = EMPTY_SNAPSHOT;
    this.notify();
  }

  current(): ModeController | null {
    return this.controller;
  }

  snapshot(): ModeSnapshot {
    return this.cached;
  }

  subscribe(cb: () => void): () => void {
    this.subs.add(cb);
    return () => {
      this.subs.delete(cb);
    };
  }

  private notify(): void {
    for (const cb of this.subs) {
      try {
        cb();
      } catch {
        // ignore
      }
    }
  }
}

export const ControllerStore = new ControllerStoreImpl();

/**
 * Convenience: create a controller and register it with the store. Returns
 * a disposer the pane should call from useEffect cleanup. Multiple calls
 * replace any previously-attached controller (the prior one is detached
 * but not disposed — disposal is the original creator's responsibility).
 */
export function acquireController(opts?: ModeControllerOptions): {
  controller: ModeController;
  release: () => void;
} {
  const controller = createModeController(opts);
  ControllerStore.attach(controller);
  let released = false;
  return {
    controller,
    release: () => {
      if (released) return;
      released = true;
      // Detach before dispose so subscribers don't observe a half-disposed
      // controller during teardown.
      if (ControllerStore.current() === controller) {
        ControllerStore.detach();
      }
      controller.dispose();
    },
  };
}

const subscribeMode = (cb: () => void) => ControllerStore.subscribe(cb);
const getModeSnapshot = () => ControllerStore.snapshot();
const getServerModeSnapshot = () => EMPTY_SNAPSHOT;

export function useModeSnapshot(): ModeSnapshot {
  return useSyncExternalStore(
    subscribeMode,
    getModeSnapshot,
    getServerModeSnapshot,
  );
}
