import "server-only";

/**
 * Sanitize room and identity strings per ARCHITECTURE.md s10:
 *   [a-zA-Z0-9_- ]{1,64}
 *
 * Throws on non-string or non-matching input. Returns the trimmed string on
 * success.
 */

const ID_RE = /^[a-zA-Z0-9_\- ]{1,64}$/;

export function sanitizeRoom(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("room must be a string");
  }
  const trimmed = input.trim();
  if (!ID_RE.test(trimmed)) {
    throw new Error("room must match [a-zA-Z0-9_- ]{1,64}");
  }
  return trimmed;
}

export function sanitizeIdentity(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("identity must be a string");
  }
  const trimmed = input.trim();
  if (!ID_RE.test(trimmed)) {
    throw new Error("identity must match [a-zA-Z0-9_- ]{1,64}");
  }
  return trimmed;
}
