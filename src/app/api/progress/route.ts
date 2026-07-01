/**
 * GET /api/progress — the signed-in player's training summary as JSON.
 *
 * Built on @supabase/server: `withSupabase({ auth: "user" })` verifies the
 * caller's JWT against SUPABASE_JWKS_URL and hands the handler an RLS-scoped
 * client (`ctx.supabase`), so every query below is automatically restricted
 * to the caller's own rows.
 *
 * Call it with the user's access token:
 *   fetch("/api/progress", { headers: { Authorization: `Bearer ${session.access_token}` } })
 *
 * Requires SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY /
 * SUPABASE_JWKS_URL (see .env.example); responds 503 when not configured.
 */
import { withSupabase } from "@supabase/server";

const configured = () =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_JWKS_URL);

const handler = withSupabase({ auth: "user" }, async (_req, ctx) => {
  const userId = ctx.userClaims?.id;
  if (!userId) {
    return Response.json({ message: "unauthenticated" }, { status: 401 });
  }

  const [profile, progress, due] = await Promise.all([
    ctx.supabase
      .from("profiles")
      .select("username, rating, attempts, correct")
      .eq("id", userId)
      .single(),
    ctx.supabase
      .from("opening_progress")
      .select("opening_id, seen, correct, streak, best_streak, mastery, updated_at")
      .order("updated_at", { ascending: false }),
    ctx.supabase
      .from("srs_cards")
      .select("epd", { count: "exact", head: true })
      .lte("due", new Date().toISOString()),
  ]);

  const error = profile.error ?? progress.error ?? due.error;
  if (error) {
    return Response.json({ message: error.message }, { status: 500 });
  }

  return Response.json({
    profile: profile.data,
    openings: progress.data,
    reviewsDue: due.count ?? 0,
  });
});

export async function GET(req: Request): Promise<Response> {
  if (!configured()) {
    return Response.json(
      { message: "Supabase is not configured on this deployment (see .env.example)." },
      { status: 503 }
    );
  }
  return handler(req);
}
