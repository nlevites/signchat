/**
 * Pluggable latency marker for runtime-browser.
 *
 * apps/web wires this to its rich LatencyStore; apps/bridge sets a no-op (or
 * a tiny ring) since it has no debug pane to render p50/p95 against. The
 * default is a no-op so the package stays usable in any host without an
 * explicit setup call.
 */

export type MarkEdge = "start" | "end";
export type MarkFn = (stage: string, turnId: string, edge: MarkEdge) => void;

const noopMark: MarkFn = () => {};

let activeMark: MarkFn = noopMark;

export function setMarkFn(fn: MarkFn): void {
  activeMark = fn;
}

export function mark(stage: string, turnId: string, edge: MarkEdge): void {
  activeMark(stage, turnId, edge);
}

/** Stable id for one logical "turn" through the system. */
export function newTurnId(): string {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
