-- OAuth identities (ADR 0009): "Sign in with Lichess / Chess.com" and the
-- ownership proof behind linked_accounts.verified. Tested on a local Postgres
-- (scripts/supabase/test-0010.sh); the owner applies it to the hosted project.
--
-- One row per (provider account → app account). The provider's stable user id
-- is the key, so one Lichess account signs in to exactly one app account, and
-- an app account has at most one identity per provider. Usernames here are
-- what the provider said at the last OAuth round trip, nothing a client typed.
--
-- Separate from linked_accounts: that row is "the games we import" and can be
-- unlinked (deleting its games) without removing a way to sign in, and its
-- username is not unique across users (anyone can type a public name).
--
-- No provider tokens are stored: Lichess tokens are revoked right after the
-- identity is read; Chess.com's ID token is read once and dropped.
--
-- Security model: own-row select; every write through the /api/auth/oauth
-- routes (service role). Deletion: cascades from profiles (→ auth.users).
-- Idempotent: safe to re-run.

create table if not exists public.oauth_identities (
  provider          text not null check (provider in ('lichess', 'chesscom')),
  -- Lichess: the lowercase user id; Chess.com: the ID token's `sub`
  provider_user_id  text not null check (provider_user_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  user_id           uuid not null references public.profiles (id) on delete cascade,
  -- as the provider displays it, refreshed on every sign-in
  username          text not null check (username ~ '^[A-Za-z0-9][A-Za-z0-9_-]{1,29}$'),
  linked_at         timestamptz not null default now(),
  last_used_at      timestamptz not null default now(),
  primary key (provider, provider_user_id),
  unique (user_id, provider)
);

alter table public.oauth_identities enable row level security;
drop policy if exists "own oauth identities" on public.oauth_identities;
create policy "own oauth identities" on public.oauth_identities for select using (user_id = auth.uid());
revoke all on public.oauth_identities from public, anon, authenticated;
grant select on public.oauth_identities to authenticated;
grant all on public.oauth_identities to service_role;
