import type { ApiError, Role } from "@signchat/contracts";

const ID_REGEX = /^[a-zA-Z0-9_\-\s]{1,64}$/;

export class BadRequest extends Error {
  status = 400;
}

export class Unauthorized extends Error {
  status = 401;
}

export class Forbidden extends Error {
  status = 403;
}

export function sanitizeRoomId(raw: unknown): string {
  if (typeof raw !== "string" || !ID_REGEX.test(raw)) {
    throw new BadRequest("invalid_room_id");
  }
  return raw;
}

export function sanitizeIdentity(raw: unknown): string {
  if (typeof raw !== "string" || !ID_REGEX.test(raw)) {
    throw new BadRequest("invalid_identity");
  }
  return raw;
}

export function sanitizeRole(raw: unknown): Role {
  if (raw !== "deaf" && raw !== "hearing") {
    throw new BadRequest("invalid_role");
  }
  return raw;
}

export function sanitizeOptionalString(
  raw: unknown,
  regex: RegExp,
  max: number,
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.length > max || !regex.test(raw)) {
    throw new BadRequest("invalid_string");
  }
  return raw;
}

export function respondError(err: unknown): Response {
  const status = (err as { status?: number } | null)?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    const message = err instanceof Error ? err.message : "request_failed";
    const body: ApiError = { error: message };
    return Response.json(body, { status });
  }
  console.error(err);
  const body: ApiError = { error: "internal_error" };
  return Response.json(body, { status: 500 });
}
