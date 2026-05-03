// single-instance only; cross-instance abuse bounded by the per-key spend cap, not by this rate limit.

const WINDOW_MS = 60_000;
const MAX_REQUESTS = 60;

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export class TooManyRequests extends Error {
  status = 429;
}

export function enforceRateLimit(ip: string, roomId: string): void {
  const key = `${ip}:${roomId}`;
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  if (bucket.count >= MAX_REQUESTS) {
    throw new TooManyRequests("rate_limited");
  }

  bucket.count += 1;
}
