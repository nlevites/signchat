import { log } from "../logger";

/**
 * IndexedDB cache for the 21 MB asl-signs ONNX model.
 *
 * After the first cold load (network ~1.5–3s), subsequent visits warm-start
 * from IndexedDB in <50ms. Cache key includes the model URL so swapping the
 * .onnx file (e.g. a freshly-trained classifier) invalidates automatically.
 *
 * The cache also stores a content hash so we can detect upstream model swaps
 * even when the URL is unchanged.
 */

const DB_NAME = "signchat-workbench";
const DB_VERSION = 1;
const STORE = "model-cache";

interface CachedModelEntry {
  url: string;
  /** Last-Modified or ETag header value if available; null otherwise. */
  etag: string | null;
  /** SHA-256 hex of the bytes; verified on read. */
  hash: string;
  cachedAt: number;
  bytes: ArrayBuffer;
}

async function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "url" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      log.warn("model-cache", "IndexedDB open failed", { err: req.error?.message });
      resolve(null);
    };
  });
}

async function idbGet(url: string): Promise<CachedModelEntry | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(url);
    req.onsuccess = () => {
      resolve((req.result as CachedModelEntry | undefined) ?? null);
    };
    req.onerror = () => {
      log.warn("model-cache", "idbGet failed", { err: req.error?.message });
      resolve(null);
    };
  });
}

async function idbPut(entry: CachedModelEntry): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      log.warn("model-cache", "idbPut failed", { err: tx.error?.message });
      resolve();
    };
  });
}

async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  if (typeof crypto === "undefined" || !crypto.subtle) return "";
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const view = new Uint8Array(digest);
  let out = "";
  for (let i = 0; i < view.length; i++) {
    out += (view[i] as number).toString(16).padStart(2, "0");
  }
  return out;
}

export interface FetchOptions {
  onProgress?: (received: number, total: number | null) => void;
  /** Force a fresh network fetch even if cached. Default: false. */
  bypassCache?: boolean;
}

export interface FetchResult {
  bytes: ArrayBuffer;
  fromCache: boolean;
  cachedAt: number | null;
  hash: string;
}

/**
 * Get model bytes, preferring IndexedDB. On cache miss or `bypassCache`,
 * fetches from network with an optional progress callback and writes back
 * to IndexedDB.
 */
export async function fetchModelCached(
  url: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  if (!options.bypassCache) {
    const cached = await idbGet(url);
    if (cached) {
      log.info("model-cache", `cache hit ${url}`, {
        bytes: cached.bytes.byteLength,
        cachedAt: new Date(cached.cachedAt).toISOString(),
      });
      // Notify the progress callback once with full size so the UI can paint
      // a 100% bar consistently across cache hits and misses.
      options.onProgress?.(cached.bytes.byteLength, cached.bytes.byteLength);
      return {
        bytes: cached.bytes,
        fromCache: true,
        cachedAt: cached.cachedAt,
        hash: cached.hash,
      };
    }
    log.info("model-cache", `cache miss ${url}`);
  } else {
    log.info("model-cache", `cache bypass ${url}`);
  }

  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status}`);
  }
  const totalHeader = res.headers.get("content-length");
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : null;
  const etag = res.headers.get("etag") ?? res.headers.get("last-modified");
  const reader = res.body?.getReader();
  let bytes: ArrayBuffer;
  if (!reader) {
    bytes = await res.arrayBuffer();
    options.onProgress?.(bytes.byteLength, bytes.byteLength);
  } else {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        options.onProgress?.(received, total);
      }
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    bytes = merged.buffer.slice(
      merged.byteOffset,
      merged.byteOffset + merged.byteLength,
    ) as ArrayBuffer;
  }

  const hash = await sha256Hex(bytes);
  await idbPut({
    url,
    etag,
    hash,
    cachedAt: Date.now(),
    bytes,
  });
  log.info("model-cache", `cached ${url}`, { bytes: bytes.byteLength, hash });
  return { bytes, fromCache: false, cachedAt: null, hash };
}

/** Wipe cache. Useful for "Clear cache" UI affordance. */
export async function clearModelCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    store.clear();
    tx.oncomplete = () => {
      log.info("model-cache", "cache cleared");
      resolve();
    };
    tx.onerror = () => resolve();
  });
}
