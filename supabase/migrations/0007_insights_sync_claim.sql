-- Account Insights (ADR 0006), follow-up: claim a sync slot atomically.
--
-- /api/insights/sync used to read the counter, check it and write it back in
-- three calls, so parallel requests could all pass the 30-per-hour limit. This
-- function does the check and the increment in one UPDATE, and only for the
-- username the client is syncing. A re-link to another name between a sync's
-- check and its writes then fails the claim instead of mixing two accounts.
--
-- Returns 0 when the slot is claimed, the seconds to wait when the limit is
-- reached, or -1 when there is no such linked account (unlinked, or linked to
-- a different username). Service role only. Idempotent: safe to re-run.

create or replace function public.insights_claim_sync(p_user uuid, p_platform text, p_username text, p_limit int)
returns int
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_start timestamptz;
begin
  update public.linked_accounts
     set sync_window_start = case when sync_window_start is null or sync_window_start <= now() - interval '1 hour' then now() else sync_window_start end,
         sync_calls        = case when sync_window_start is null or sync_window_start <= now() - interval '1 hour' then 1 else sync_calls + 1 end
   where user_id = p_user
     and platform = p_platform
     and lower(username) = lower(p_username)
     and (sync_window_start is null or sync_window_start <= now() - interval '1 hour' or sync_calls < p_limit)
  returning sync_window_start into v_start;
  if found then
    return 0;
  end if;
  select sync_window_start into v_start
    from public.linked_accounts
   where user_id = p_user and platform = p_platform and lower(username) = lower(p_username);
  if not found then
    return -1;
  end if;
  return greatest(1, ceil(extract(epoch from (v_start + interval '1 hour' - now())))::int);
end;
$$;

revoke execute on function public.insights_claim_sync(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.insights_claim_sync(uuid, text, text, int) to service_role;
