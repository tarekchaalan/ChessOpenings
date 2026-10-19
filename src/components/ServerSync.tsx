"use client";
/**
 * Signed-in only (ADR 0004): checks the server's theory version, pulls the
 * account's cards, runs the one-time remap and mirrors the daily cap's
 * deferrals. Guests render nothing and load nothing; signed in, the dataset
 * and the course code load only if the remap needs them.
 */
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useServerSync } from "@/lib/train-sync";

export default function ServerSync() {
  const { user } = useAuth();
  return user ? <Sync userId={user.id} /> : null;
}

function Sync({ userId }: { userId: string }) {
  useServerSync(userId);
  return null;
}
