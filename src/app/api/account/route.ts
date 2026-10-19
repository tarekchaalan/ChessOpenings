/**
 * DELETE /api/account — permanently deletes the signed-in player's account.
 *
 * `withSupabase({ auth: "user" })` verifies the caller's JWT; the auth user is
 * then deleted with the service-role client, and every user table cascades
 * from it (profiles → auth.users, the rest → profiles, all `on delete
 * cascade`). The body must repeat the username as a typed confirmation, so a
 * stray request with a valid token can't delete anything by itself.
 */
import { withSupabase } from "@supabase/server";

const configured = () =>
  Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY && process.env.SUPABASE_JWKS_URL && process.env.SUPABASE_SECRET_KEY);

// same-origin only: no CORS headers for a destructive endpoint
const handler = withSupabase({ auth: "user", cors: false }, async (req, ctx) => {
  const userId = ctx.userClaims?.id;
  if (!userId) return Response.json({ message: "unauthenticated" }, { status: 401 });

  let confirm: unknown;
  try {
    confirm = ((await req.json()) as { confirm?: unknown })?.confirm;
  } catch {
    return Response.json({ message: "invalid JSON" }, { status: 400 });
  }
  const { data, error: profileError } = await ctx.supabaseAdmin.from("profiles").select("username").eq("id", userId).maybeSingle();
  const profile = data as { username: string } | null;
  if (profileError) {
    console.error("[api/account] profile lookup", profileError);
    return Response.json({ message: "server error" }, { status: 500 });
  }
  // no profile row: the account's email is the confirmation instead
  const expected = (profile?.username ?? ctx.userClaims?.email ?? "").toLowerCase();
  if (!expected || typeof confirm !== "string" || confirm.trim().toLowerCase() !== expected) {
    return Response.json({ message: "confirmation does not match" }, { status: 400 });
  }

  const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(userId);
  if (error) {
    console.error("[api/account] delete", error);
    return Response.json({ message: "Could not delete the account. Please try again." }, { status: 500 });
  }
  return new Response(null, { status: 204 });
});

export async function DELETE(req: Request): Promise<Response> {
  if (!configured()) {
    return Response.json({ message: "Account deletion is not configured on this deployment." }, { status: 503 });
  }
  return handler(req);
}
