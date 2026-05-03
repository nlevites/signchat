import "server-only";

/**
 * In-memory token bucket per (route, IP).
 *
 * Architecture spec (ARCHITECTURE.md s14): 60 req/min/IP on the mint routes.
 * This impl is single-process and dies on Lambda cold start; in production we
 * swap it for Vercel KV. Acceptable for dev/hackathon.
 */

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();

export function consumeToken(
  routeKey: string,
  ip: string,
  capacity = 60,
  perMinute = 60,
): boolean {
  const key = `${routeKey}:${ip}`;
  const now = Date.now();
  const refillRate = perMinute / 60_000; // tokens per ms
  const existing = buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };
  const elapsed = now - existing.lastRefillMs;
  const refilled: Bucket = {
    tokens: Math.min(capacity, existing.tokens + elapsed * refillRate),
    lastRefillMs: now,
  };
  if (refilled.tokens < 1) {
    buckets.set(key, refilled);
    return false;
  }
  refilled.tokens -= 1;
  buckets.set(key, refilled);
  return true;
}

/**
 * Best-effort client IP extraction from a Request. Vercel sets
 * `x-forwarded-for` and `x-real-ip`; locally these may be absent so we fall
 * back to "unknown".
 */
export function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}
