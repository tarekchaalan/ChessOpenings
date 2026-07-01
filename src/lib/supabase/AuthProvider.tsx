"use client";
/**
 * Session context for the whole app. Guests get a null user and the app
 * falls back to localStorage persistence; signed-in users get server-side
 * progress and the leaderboard.
 */
import { createContext, useContext, useEffect, useState } from "react";
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

  const loadProfile = async (uid: string | undefined) => {
    const sb = getSupabase();
    if (!sb || !uid) {
      setUsername(null);
      return;
    }
    const { data } = await sb.from("profiles").select("username").eq("id", uid).single();
    setUsername(data?.username ?? null);
  };

  useEffect(() => {
    const sb = getSupabase();
    if (!sb) return;
    sb.auth.getUser().then(({ data }) => {
      setUser(data.user ?? null);
      loadProfile(data.user?.id).finally(() => setLoading(false));
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      loadProfile(session?.user?.id);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        username,
        loading,
        configured,
        signOut: async () => {
          await getSupabase()?.auth.signOut();
          setUser(null);
          setUsername(null);
        },
        refreshProfile: () => loadProfile(user?.id),
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
