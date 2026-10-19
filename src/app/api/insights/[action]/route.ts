/**
 * POST /api/insights/{link,sync,unlink} — Account Insights writes for
 * signed-in players (ADR 0006). The browser fetches games from Lichess and
 * Chess.com itself; only derived summaries arrive here. `withSupabase({ auth:
 * "user" })` verifies the caller's JWT; writes go through the service-role
 * client after the checks in lib/server/insights.ts. Reads use the browser
 * client under RLS. Without the Supabase env every action answers 503 and
 * Insights stays in the browser, as for guests.
 */
import { withSupabase } from "@supabase/server";
import { link, sync, unlink, type InsightsDb } from "@/lib/server/insights";
import { supabaseInsightsDb } from "@/lib/server/insights-db";
import type { Result } from "@/lib/server/train";

const ACTIONS: Record<string, (db: InsightsDb, userId: string, body: unknown) => Promise<Result>> = { link, sync, unlink };

const configured = () =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_JWKS_URL && process.env.SUPABASE_SECRET_KEY);

// a sync carries at most 200 summaries (about 0.5 KB each)
const MAX_BODY = 512 * 1024;

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }): Promise<Response> {
  const { action } = await params;
  const run = ACTIONS[action];
  if (!run) return Response.json({ message: "unknown action" }, { status: 404 });
  if (!configured()) return Response.json({ message: "Account Insights storage is not configured on this deployment." }, { status: 503 });
  const handler = withSupabase({ auth: "user", cors: false }, async (r, ctx) => {
    const userId = ctx.userClaims?.id;
    if (!userId) return Response.json({ message: "unauthenticated" }, { status: 401 });
    const text = await r.text();
    if (text.length > MAX_BODY) return Response.json({ message: "request too large" }, { status: 413 });
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ message: "invalid JSON" }, { status: 400 });
    }
    try {
      const res = await run(supabaseInsightsDb(ctx.supabaseAdmin), userId, body);
      return Response.json(res.body, { status: res.status });
    } catch (e) {
      console.error(`[api/insights/${action}]`, e);
      return Response.json({ message: "server error" }, { status: 500 });
    }
  });
  return handler(req);
}
