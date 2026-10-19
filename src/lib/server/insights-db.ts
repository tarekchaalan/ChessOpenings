/**
 * InsightsDb over Supabase (service role, server only). Every call is scoped
 * to the user id the route handler took from the verified JWT.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "@/lib/insights/types";
import type { AccountRow, InsightsDb } from "./insights";

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export function supabaseInsightsDb(admin: SupabaseClient): InsightsDb {
  return {
    async getAccount(userId, platform) {
      return check(await admin.from("linked_accounts").select("*").eq("user_id", userId).eq("platform", platform).maybeSingle()) as AccountRow | null;
    },
    async putAccount(row, replace) {
      if (replace) check(await admin.from("linked_accounts").delete().eq("user_id", row.user_id).eq("platform", row.platform));
      check(await admin.from("linked_accounts").upsert(row, { onConflict: "user_id,platform" }));
    },
    async updateAccount(userId, platform, patch) {
      check(await admin.from("linked_accounts").update(patch).eq("user_id", userId).eq("platform", platform));
    },
    async deleteAccount(userId, platform) {
      check(await admin.from("linked_accounts").delete().eq("user_id", userId).eq("platform", platform));
    },
    async upsertGames(rows) {
      check(await admin.from("game_summaries").upsert(rows, { onConflict: "user_id,platform,game_id" }));
    },
    async pruneGames(userId: string, platform: Platform, keep: number) {
      let removed = 0;
      for (;;) {
        const old = check(
          await admin.from("game_summaries").select("game_id").eq("user_id", userId).eq("platform", platform).order("played_at", { ascending: false }).range(keep, keep + 499)
        ) as { game_id: string }[];
        if (!old.length) return removed;
        check(await admin.from("game_summaries").delete().eq("user_id", userId).eq("platform", platform).in("game_id", old.map((r) => r.game_id)));
        removed += old.length;
      }
    },
  };
}
