import "server-only";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return Response.json({
    ok: true,
    region: process.env.VERCEL_REGION ?? "local",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev",
  });
}
