import type { HealthResponse } from "@signchat/contracts";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const body: HealthResponse = {
    ok: true,
    region: "pdx1",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  };
  return Response.json(body);
}
