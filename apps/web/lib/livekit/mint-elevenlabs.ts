import type { CreateElevenLabsSignedUrlResponse } from "@signchat/contracts";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";

export interface MintElevenLabsArgs {
  roomId: string;
  identity: string;
  role: "deaf";
  /** Optional override; server falls back to ELEVENLABS_VOICE_ID. */
  voiceId?: string;
}

export class ElevenLabsSignedUrlError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ElevenLabsSignedUrlError";
    this.status = status;
  }
}

export async function mintElevenLabsSignedUrl(
  args: MintElevenLabsArgs,
): Promise<CreateElevenLabsSignedUrlResponse> {
  const probe = newTurnId();
  mark("mint.elevenlabs", probe, "start");
  try {
    const res = await fetch("/api/elevenlabs/signed-url", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: args.roomId,
        identity: args.identity,
        role: args.role,
        ...(args.voiceId !== undefined ? { voiceId: args.voiceId } : {}),
      }),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const errBody = (await res.json()) as { error?: string };
        if (errBody.error) detail = `${res.status} ${errBody.error}`;
      } catch {
        // body wasn't json — keep the status-only detail
      }
      throw new ElevenLabsSignedUrlError(
        `signed-url mint failed: ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as CreateElevenLabsSignedUrlResponse;
  } finally {
    mark("mint.elevenlabs", probe, "end");
  }
}
