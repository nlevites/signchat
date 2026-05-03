import type { CreateElevenLabsSttSignedUrlResponse } from "@signchat/contracts";
import { mark, newTurnId } from "@/lib/diagnostics/latency-markers";

export interface MintElevenLabsSttArgs {
  roomId: string;
  identity: string;
  role: "deaf";
}

export class ElevenLabsSttSignedUrlError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ElevenLabsSttSignedUrlError";
    this.status = status;
  }
}

export async function mintElevenLabsSttSignedUrl(
  args: MintElevenLabsSttArgs,
): Promise<CreateElevenLabsSttSignedUrlResponse> {
  const probe = newTurnId();
  mark("mint.elevenlabs-stt", probe, "start");
  try {
    const res = await fetch("/api/elevenlabs/stt-signed-url", {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        roomId: args.roomId,
        identity: args.identity,
        role: args.role,
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
      throw new ElevenLabsSttSignedUrlError(
        `stt-signed-url mint failed: ${detail}`,
        res.status,
      );
    }
    return (await res.json()) as CreateElevenLabsSttSignedUrlResponse;
  } finally {
    mark("mint.elevenlabs-stt", probe, "end");
  }
}
