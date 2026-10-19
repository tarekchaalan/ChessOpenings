"use client";
/**
 * Session context for the whole app. Guests get a null user and the app
 * falls back to localStorage persistence; signed-in users get server-side
 * progress and the leaderboard.
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { getSupabase, supabaseConfigured } from "./client";

interface AuthState {
  user: User | null;
  username: string | null;
  loading: boolean;
  configured: boolean;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  username: null,
  loading: false,
  configured: false,
  signOut: async () => {},
  refreshProfile: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const configured = supabaseConfigured();
  const [user, setUser] = useState<User | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState(configured);
  const userRef = useRef<User | null>(null);
  // only the latest profile request may write (a sign-out mid-request must not resurrect a name)
  const seq = useRef(0);

  const loadProfile = useCallback(async (uid: string | undefined) => {
    const n = ++seq.current;
    const sb = getSupabase();
    if (!sb || !uid) {
      setUsername(null);
      return;
    }
    const { data, error } = await sb.from("profiles").select("username").eq("id", uid).maybeSingle();
    let name = data?.username ?? null;
    if (!error && !name) {
      // no profile row (an account older than the sign-up trigger, or a failed trigger): create it
      const res = await sb.rpc("ensure_profile");
      if (!res.error && typeof res.data === "string") name = res.data;
    }
    if (n === seq.current) setUsername(name);
  }, []);

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    // an email link that failed after falling back to the Site URL carries the error in the hash
    const hash = new URLSearchParams(window.location.hash.slice(1));
    const linkError = hash.get("error_code") ?? hash.get("error");
    if (linkError && window.location.pathname !== "/auth") {
      window.location.replace(`/auth?error=${encodeURIComponent(linkError)}`);
      return;
    }

    const apply = (u: User | null) => {
      const changed = userRef.current?.id !== u?.id;
      userRef.current = u;
      setUser(u);
      if (changed) {
        if (!u) seq.current++; // drop any in-flight profile load
        if (!u) setUsername(null);
        return loadProfile(u?.id);
      }
    };
    sb.auth
      .getUser()
      .then(({ data }) => apply(data.user ?? null))
      .catch(() => apply(null))
      .finally(() => setLoading(false));
    const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
      // Supabase calls made inside this callback can deadlock on the auth lock: defer them
      setTimeout(() => {
        if (event === "PASSWORD_RECOVERY" && window.location.pathname !== "/auth/reset") {
          window.location.assign("/auth/reset");
          return;
        }
        if (event === "USER_UPDATED" || event === "TOKEN_REFRESHED") {
          userRef.current = session?.user ?? null;
          setUser(session?.user ?? null);
          return;
        }
        apply(session?.user ?? null);
      }, 0);
    });
    return () => sub.subscription.unsubscribe();
  }, [loadProfile]);

  const signOut = useCallback(async () => {
    const sb = getSupabase();
    seq.current++;
    try {
      // this device only; a failed network call must still sign the browser out
      const { error } = (await sb?.auth.signOut({ scope: "local" })) ?? { error: null };
      if (error) await sb?.auth.signOut({ scope: "local" }).catch(() => undefined);
    } finally {
      userRef.current = null;
      setUser(null);
      setUsername(null);
    }
  }, []);

  const refreshProfile = useCallback(() => loadProfile(userRef.current?.id), [loadProfile]);

  return (
    <AuthContext.Provider value={{ user, username, loading, configured, signOut, refreshProfile }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
