-- Playlist-based quizzing: issue_challenge learns two optional parameters.
--   p_target — a named variation (SAN array); while the game stays on this
--              line the opponent follows it instead of sampling by frequency.
--   p_start  — pre-play this many plies of p_target before quizzing, so a new
--              line starts from where it diverges from the previous one.
-- Every pre-played and opponent move is still validated against theory_edges
-- / the family's named lines, so arbitrary targets can't inject positions.

drop function if exists public.issue_challenge(int, text, uuid);

create or replace function public.issue_challenge(
  p_opening_id int,
  p_side text,
  p_prev uuid default null,
  p_target text[] default null,
  p_start int default 0
)
returns jsonb
language plpgsql
security definer set search_path = public, pg_temp
as $$
declare
  v_user uuid := auth.uid();
  v_prefix text[] := '{}';
  v_epd text := public.start_epd();
  v_prev record;
  v_prev_san text;
  v_user_turn boolean;
  v_candidates text[];
  v_pick record;
  v_id uuid;
  v_expected text[];
  v_next_epd text;
  v_target_san text;
  i int;
begin
  if v_user is null then raise exception 'not authenticated'; end if;
  if p_side not in ('white', 'black') then raise exception 'bad side'; end if;
  if not exists (select 1 from theory_openings where id = p_opening_id) then
    raise exception 'unknown opening';
  end if;

  -- rate limit: at most 60 issued challenges per minute
  if (select count(*) from quiz_challenges
      where user_id = v_user and issued_at > now() - interval '1 minute') >= 60 then
    raise exception 'rate_limited';
  end if;

  if p_prev is not null then
    -- continue the previous line only after a correct answer
    select c.*, a.san as answered_san into v_prev
    from quiz_challenges c
    join quiz_attempts a on a.challenge_id = c.id
    where c.id = p_prev and c.user_id = v_user;
    if found and v_prev.answered and v_prev.answered_correct then
      v_prev_san := v_prev.answered_san;
      v_prefix := v_prev.line_san || v_prev_san;
      select to_epd into v_epd from theory_edges
        where from_epd = v_prev.epd and san = v_prev_san;
      if v_epd is null then
        return jsonb_build_object('done', true);
      end if;
    end if;
  elsif p_target is not null and p_start > 0 then
    -- pre-play the shared trunk of the target line, validating each move
    for i in 1..least(p_start, greatest(cardinality(p_target) - 2, 0)) loop
      select to_epd into v_next_epd from theory_edges
        where from_epd = v_epd and san = p_target[i];
      exit when v_next_epd is null;
      v_prefix := v_prefix || p_target[i];
      v_epd := v_next_epd;
    end loop;
  end if;

  -- walk opponent moves until the user's turn
  loop
    v_user_turn := (cardinality(v_prefix) % 2 = 0) = (p_side = 'white');

    select array_agg(san) into v_candidates
    from public.family_next_moves(p_opening_id, v_prefix);

    if v_candidates is null or cardinality(v_candidates) = 0 then
      return jsonb_build_object(
        'id', gen_random_uuid(), 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', true);
    end if;

    if v_user_turn then
      select array_agg(e.san order by e.games desc) into v_expected
      from theory_edges e
      where e.from_epd = v_epd and e.san = any (v_candidates);
      if v_expected is null then v_expected := v_candidates; end if;

      insert into quiz_challenges (user_id, opening_id, side, line_san, epd, expected)
      values (v_user, p_opening_id, p_side, v_prefix, v_epd, v_expected)
      returning id into v_id;

      return jsonb_build_object(
        'id', v_id, 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', false);
    end if;

    -- opponent: follow the target line while still on it, else weighted random
    v_target_san := null;
    if p_target is not null
       and cardinality(p_target) > cardinality(v_prefix)
       and p_target[1:cardinality(v_prefix)] = v_prefix
       and p_target[cardinality(v_prefix) + 1] = any (v_candidates) then
      v_target_san := p_target[cardinality(v_prefix) + 1];
    end if;

    if v_target_san is not null then
      select e.san, e.to_epd into v_pick
      from theory_edges e
      where e.from_epd = v_epd and e.san = v_target_san;
    else
      select e.san, e.to_epd into v_pick
      from theory_edges e
      where e.from_epd = v_epd and e.san = any (v_candidates)
      order by -ln(random()) / (e.games + 1)
      limit 1;
    end if;
    if v_pick is null then
      return jsonb_build_object(
        'id', gen_random_uuid(), 'sans', to_jsonb(v_prefix), 'epd', v_epd,
        'ply', cardinality(v_prefix), 'done', true);
    end if;

    v_prefix := v_prefix || v_pick.san;
    v_epd := v_pick.to_epd;
  end loop;
end;
$$;

revoke execute on function public.issue_challenge(int, text, uuid, text[], int) from public, anon;
grant execute on function public.issue_challenge(int, text, uuid, text[], int) to authenticated;
