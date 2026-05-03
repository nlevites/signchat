import type {
  CreateOpenRouterSessionKeyRequest,
  CreateOpenRouterSessionKeyResponse,
} from "@signchat/contracts";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";

export interface MintOpenRouterArgs {
  roomId: string;
  identity: string;
  role: "deaf";
}

export class OpenRouterSessionKeyError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenRouterSessionKeyError";
    this.status = status;
  }
}

export async function mintOpenRouterSessionKey(
  args: MintOpenRouterArgs,
): Promise<CreateOpenRouterSessionKeyResponse> {
  const probe = newTurnId();
  mark("mint.openrouter", probe, "start");
  try {
    const body: CreateOpenRouterSessionKeyRequest = {
      roomId: args.roomId,
      identity: args.identity,
      role: args.role,
    };
    const res = await fetch("/api/openrouter/session-key", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody.error) detail = `${res.status} ${errBody.error}`;
      } catch {
        // body wasn't json — keep the status-only detail
      }
      throw new OpenRouterSessionKeyError(
        `session-key mint failed: ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as CreateOpenRouterSessionKeyResponse;
  } finally {
    mark("mint.openrouter", probe, "end");
  }
}
