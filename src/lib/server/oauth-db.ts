/**
 * OAuthDb over Supabase (service role, server only), plus the two auth-admin
 * calls the callback needs: creating the account of a first OAuth sign-in, and
 * a one-time token to start a session for a user (ADR 0009).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import type { cookies } from "next/headers";
import type { OAuthProvider } from "@/lib/oauth/providers";
import { supabaseInsightsDb } from "./insights-db";
import { OAuthError, type IdentityRow, type OAuthDb } from "./oauth";

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/** The service-role client, or null without the server env (the same variables as the other API routes). */
export function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The visitor's session client over the request cookies (as in /auth/callback), or null without the public env. */
export function cookieClient(store: Awaited<ReturnType<typeof cookies>>): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createServerClient(url, key, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => list.forEach(({ name, value, options }) => store.set(name, value, options)),
    },
  });
}

export function supabaseOAuthDb(admin: SupabaseClient): OAuthDb {
  const { getAccount, putAccount, updateAccount } = supabaseInsightsDb(admin);
  const findIdentity = async (provider: OAuthProvider, providerUserId: string) =>
    check(await admin.from("oauth_identities").select("provider, provider_user_id, user_id, username").eq("provider", provider).eq("provider_user_id", providerUserId).maybeSingle()) as IdentityRow | null;
  return {
    getAccount,
    putAccount,
    updateAccount,
    findIdentity,
    async putIdentity(row) {
      check(await admin.from("oauth_identities").delete().eq("user_id", row.user_id).eq("provider", row.provider).neq("provider_user_id", row.provider_user_id));
      const res = await admin.from("oauth_identities").insert(row);
      if (!res.error) return;
      if (res.error.code !== "23505") throw new Error(res.error.message);
      // already there: fine if it's this user's (a retried callback), refused if it's someone else's
      const owner = await findIdentity(row.provider, row.provider_user_id);
      if (owner?.user_id !== row.user_id) throw new OAuthError("oauth_taken");
      check(await admin.from("oauth_identities").update({ username: row.username, last_used_at: new Date().toISOString() }).eq("provider", row.provider).eq("provider_user_id", row.provider_user_id));
    },
    async touchIdentity(provider, providerUserId, username) {
      check(await admin.from("oauth_identities").update({ username, last_used_at: new Date().toISOString() }).eq("provider", provider).eq("provider_user_id", providerUserId));
    },
    async ensureUser(email, username) {
      const created = await admin.auth.admin.createUser({ email, email_confirm: true, user_metadata: username ? { username } : {} });
      if (created.data.user) return created.data.user.id;
      if (created.error?.code !== "email_exists") throw new Error(created.error?.message ?? "createUser failed");
      // a first sign-in that stopped after creating the user (or ran concurrently): the link lookup returns it
      const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (!link.data.user) throw new Error(link.error?.message ?? "user lookup failed");
      return link.data.user.id;
    },
  };
}

/**
 * A one-time token hash for `userId` that `auth.verifyOtp({ type: "magiclink",
 * token_hash })` turns into a session on the visitor's cookies. generateLink
 * sends no email; the token is single-use and never leaves the server.
 */
export async function sessionTokenHash(admin: SupabaseClient, userId: string): Promise<string> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  const email = data.user?.email;
  if (error || !email) throw new Error(error?.message ?? "user has no email");
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const hash = link.data.properties?.hashed_token;
  if (!hash) throw new Error(link.error?.message ?? "generateLink failed");
  return hash;
}
