/**
 * POST /api/train/{issue,answer,defer,remap,progress} — server grading for
 * signed-in users (ADR 0004). `withSupabase({ auth: "user" })` verifies the
 * caller's JWT; writes go through the service-role client only after the
 * checks in lib/server/train.ts. Without the Supabase env (guest-only
 * deploys) every action answers 503 and the client grades locally.
 */
import { withSupabase } from "@supabase/server";
import { answer, defer, issue, progress, remap, type Result, type TrainDb } from "@/lib/server/train";
import { supabaseTrainDb } from "@/lib/server/train-db";

const ACTIONS: Record<string, (db: TrainDb, userId: string, body: unknown) => Promise<Result>> = { issue, answer, defer, remap, progress };

const configured = () =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_JWKS_URL && process.env.SUPABASE_SECRET_KEY);

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await params;
  const run = ACTIONS[action];
  if (!run) return Response.json({ message: "unknown action" }, { status: 404 });
  if (!configured()) return Response.json({ message: "Server grading is not configured on this deployment." }, { status: 503 });
  const handler = withSupabase({ auth: "user" }, async (r, ctx) => {
    const userId = ctx.userClaims?.id;
    if (!userId) return Response.json({ message: "unauthenticated" }, { status: 401 });
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return Response.json({ message: "invalid JSON" }, { status: 400 });
    }
    try {
      const res = await run(supabaseTrainDb(ctx.supabaseAdmin), userId, body);
      return Response.json(res.body, { status: res.status });
    } catch (e) {
      console.error(`[api/train/${action}]`, e);
      return Response.json({ message: "server error" }, { status: 500 });
    }
  });
  return handler(req);
}
