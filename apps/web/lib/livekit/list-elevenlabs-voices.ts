import type { ListElevenLabsVoicesResponse } from "@signchat/contracts";

export class ListElevenLabsVoicesError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ListElevenLabsVoicesError";
    this.status = status;
  }
}

export async function listElevenLabsVoices(): Promise<ListElevenLabsVoicesResponse> {
  const res = await fetch("/api/elevenlabs/voices", {
    method: "GET",
    cache: "no-store",
  });
  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const errBody = (await res.json()) as { error?: string };
      if (errBody.error) detail = `${res.status} ${errBody.error}`;
    } catch {
      // not json; keep status-only detail
    }
    throw new ListElevenLabsVoicesError(
      `voices fetch failed: ${detail}`,
      res.status,
    );
  }
  return (await res.json()) as ListElevenLabsVoicesResponse;
}
