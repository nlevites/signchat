/**
 * Sign label loading and top-K extraction for the 250-class PopSign / Kaggle
 * asl-signs vocabulary.
 *
 * The on-disk file matches the canonical Kaggle competition format:
 *   { "<sign_name>": <prediction_index>, ... }
 *
 * Source asset: apps/web/public/models/asl-signs/sign_to_prediction_index_map.json
 * Spec: https://www.kaggle.com/competitions/asl-signs/data
 */

export const LABELS_URL = "/models/asl-signs/sign_to_prediction_index_map.json";

export type SignToIndexMap = Record<string, number>;

export interface SignLabels {
  /** Raw {sign_name: index} from the JSON file. */
  signToIndex: SignToIndexMap;
  /** index -> sign_name; positions where the JSON had no entry are "?". */
  indexToLabel: ReadonlyArray<string>;
  /** Number of classes; 250 for the standard Kaggle map. */
  numClasses: number;
}

/**
 * Fetch and validate the index map. Throws on HTTP error or unexpected shape.
 * Network call only; no caching here so the caller decides cache lifetime.
 */
export async function fetchSignLabels(
  url: string = LABELS_URL,
  init?: RequestInit,
): Promise<SignLabels> {
  const res = await fetch(url, { cache: "force-cache", ...init });
  if (!res.ok) {
    throw new Error(`failed to load sign labels from ${url}: ${res.status}`);
  }
  const raw: unknown = await res.json();
  return parseSignLabels(raw);
}

/** Validate and invert the raw JSON into the canonical SignLabels shape. */
export function parseSignLabels(raw: unknown): SignLabels {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("sign_to_prediction_index_map.json: expected JSON object");
  }
  const signToIndex: SignToIndexMap = {};
  let maxIndex = -1;
  for (const [name, idxRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof idxRaw !== "number" || !Number.isInteger(idxRaw) || idxRaw < 0) {
      throw new Error(`label "${name}" has non-integer / negative index: ${String(idxRaw)}`);
    }
    signToIndex[name] = idxRaw;
    if (idxRaw > maxIndex) maxIndex = idxRaw;
  }
  if (maxIndex < 0) {
    throw new Error("sign_to_prediction_index_map.json contained no entries");
  }
  const numClasses = maxIndex + 1;
  const indexToLabel: string[] = new Array(numClasses).fill("?");
  for (const [name, idx] of Object.entries(signToIndex)) {
    indexToLabel[idx] = name;
  }
  return {
    signToIndex,
    indexToLabel,
    numClasses,
  };
}

// === softmax + topK ==========================================================

/**
 * Numerically-stable softmax of `logits` in place-free form. Returns a new
 * Float32Array of the same length.
 */
export function softmax(logits: Float32Array | ReadonlyArray<number>): Float32Array {
  const len = logits.length;
  const out = new Float32Array(len);
  if (len === 0) return out;
  let max = -Infinity;
  for (let i = 0; i < len; i++) {
    const v = logits[i] as number;
    if (v > max) max = v;
  }
  let sum = 0;
  for (let i = 0; i < len; i++) {
    const e = Math.exp((logits[i] as number) - max);
    out[i] = e;
    sum += e;
  }
  if (sum > 0) {
    const inv = 1 / sum;
    for (let i = 0; i < len; i++) {
      out[i] = (out[i] as number) * inv;
    }
  }
  return out;
}

export interface TopKEntry {
  index: number;
  label: string;
  score: number;
}

/**
 * Return the K highest-scoring (index, label, score) entries, sorted desc.
 * Uses a small fixed-size insertion ordered list so O(N*K) for K << N — fine
 * for 250 classes.
 */
export function topK(
  scores: Float32Array | ReadonlyArray<number>,
  labels: ReadonlyArray<string>,
  k: number,
): TopKEntry[] {
  const n = Math.min(scores.length, labels.length);
  const limit = Math.max(1, Math.min(k, n));
  const heap: TopKEntry[] = [];
  for (let i = 0; i < n; i++) {
    const score = scores[i] as number;
    if (heap.length < limit) {
      insertDesc(heap, { index: i, label: labels[i] ?? "?", score });
    } else {
      const lastEntry = heap[heap.length - 1];
      if (lastEntry && score > lastEntry.score) {
        heap.pop();
        insertDesc(heap, { index: i, label: labels[i] ?? "?", score });
      }
    }
  }
  return heap;
}

function insertDesc(arr: TopKEntry[], entry: TopKEntry): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((arr[mid] as TopKEntry).score >= entry.score) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, entry);
}
