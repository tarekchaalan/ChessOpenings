-- v1 → v2 user-data migration (ADR 0004 step 3). IRREVERSIBLE for the live
-- tables; the v1 rows are KEPT as *_v1_backup tables (never dropped here).
--
-- Run once, AFTER supabase/migrations/0004_v2_schema.sql, supabase/seed/*.sql and
-- scripts/supabase/seed-legacy-v1/*.sql (legacy_openings_v1 / legacy_row_answers_v1 /
-- legacy_answers_v1; its last file checks the row counts), each set in file-name order:
--   paste the whole file into the Supabase SQL editor and run it, or
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/supabase/migrate-v2-data.sql
-- Plain SQL only (no psql meta-commands): it is one transaction either way.
-- Re-running is a no-op (guarded on srs_cards_v1_backup existing).
--
-- Mapping (same tables and rules as the guest migration, src/lib/progress/migrate-v1.ts):
--   side   = side to move at epd
--   answer = legacy_row_answers_v1 when the card's line is a prefix of its v1 row,
--            else legacy_answers_v1 for the position; no row → the card is reported, not moved
--   FSRS   = stability max(0.5, interval) (interval clamped to 36500 d), difficulty
--            clamp(5 + (2.5 − ease)·4/1.2, 1, 10), due/reps/lapses kept, state Review
--            (reps > 0) / Relearning (lapsed) / New, last_review = due − interval
--   merge  = most reps (ties → earliest due) wins; lapses, seen, correct summed

begin;

do $$
begin
  if to_regclass('public.srs_cards_v1_backup') is not null then
    raise notice 'migrate-v2-data: already applied (srs_cards_v1_backup exists), nothing to do';
    return;
  end if;
  if to_regclass('public.srs_cards_v2') is null then
    raise exception 'migrate-v2-data: srs_cards_v2 missing: apply 0004_v2_schema.sql first';
  end if;
  if not exists (select 1 from public.legacy_answers_v1) then
    raise exception 'migrate-v2-data: legacy_answers_v1 is empty: load scripts/supabase/seed-legacy-v1/*.sql first';
  end if;

  -- ── cards ─────────────────────────────────────────────────────────────────
  create temp table mv_cards on commit drop as
  select
    c.user_id, c.opening_id, c.epd, c.ease, c.interval_days, c.reps, c.lapses, c.due, c.seen, c.correct,
    case when split_part(c.epd, ' ', 2) = 'w' then 'white' else 'black' end as side,
    case when ra.opening_id is not null then ra.answer_san else la.answer_san end as answer_san,
    case when ra.opening_id is not null then ra.course_id else la.course_id end as course_id,
    ra.opening_id is not null as on_row
  from public.srs_cards c
  left join public.legacy_openings_v1 lo on lo.opening_id = c.opening_id
  left join public.legacy_row_answers_v1 ra
    on ra.opening_id = c.opening_id and ra.ply = cardinality(c.line_san) and ra.epd = c.epd
   -- the card's line is a prefix of its v1 row
   and lo.sans[1:ra.ply] = array(select regexp_replace(x, '[+#?!]+$', '') from unnest(c.line_san) with ordinality u(x, i) order by i)
  left join public.legacy_answers_v1 la on la.epd = c.epd;

  create temp table mv_merged on commit drop as
  with ranked as (
    select m.*,
      row_number() over (partition by user_id, side, epd, answer_san order by reps desc, due asc) as rn,
      sum(lapses)  over (partition by user_id, side, epd, answer_san) as s_lapses,
      sum(seen)    over (partition by user_id, side, epd, answer_san) as s_seen,
      sum(correct) over (partition by user_id, side, epd, answer_san) as s_correct,
      count(*)     over (partition by user_id, side, epd, answer_san) as n
    from mv_cards m where answer_san is not null
  )
  select *,
    least(interval_days, 36500) as ivl,
    case when interval_days > 0 then due - interval_days * interval '1 day' else due - interval '10 minutes' end as last_rev
  from ranked where rn = 1;

  insert into public.srs_cards_v2 (user_id, side, epd, answer_san, due, stability, difficulty, elapsed_days,
    scheduled_days, learning_steps, reps, lapses, state, last_review, seen, correct, archived, migrated_from,
    last_course_id, updated_at)
  select user_id, side, epd, answer_san,
    case when interval_days > 0 then last_rev + ivl * interval '1 day' else due end,
    greatest(0.5, ivl),
    least(10, greatest(1, 5 + (2.5 - ease) * (4 / 1.2))),
    0, round(ivl), 0, reps, s_lapses,
    case when reps > 0 then 2 when seen > 0 then 3 else 0 end,
    case when reps > 0 or seen > 0 then last_rev end,
    s_seen, s_correct, false, 'sm2', course_id, now()
  from mv_merged;

  -- ── opening progress → course progress ────────────────────────────────────
  -- keyed by the course most of the opening's cards landed in, else the
  -- legacy map's best course; summed per (user, course)
  insert into public.course_progress (user_id, course_id, seen, correct, streak, best_streak, mastery, last_line_id, updated_at)
  select op.user_id, tgt.course_id, sum(op.seen), sum(op.correct), sum(op.streak), max(op.best_streak), 0,
    max(lo.best_line_id) filter (where lo.best_course_id = tgt.course_id), max(op.updated_at)
  from public.opening_progress op
  left join public.legacy_openings_v1 lo on lo.opening_id = op.opening_id
  cross join lateral (
    select coalesce(
      (select m.course_id from mv_cards m
        where m.user_id = op.user_id and m.opening_id = op.opening_id and m.course_id is not null
        group by m.course_id order by count(*) desc, m.course_id limit 1),
      lo.best_course_id) as course_id
  ) tgt
  where tgt.course_id is not null
  group by op.user_id, tgt.course_id;

  -- ── report (read by the dry run) ──────────────────────────────────────────
  create table if not exists public.migration_report_v2 (
    k text primary key, v bigint not null, at timestamptz not null default now()
  );
  alter table public.migration_report_v2 enable row level security;
  insert into public.migration_report_v2 (k, v) values
    ('v1_cards', (select count(*) from mv_cards)),
    ('v1_cards_unmapped', (select count(*) from mv_cards where answer_san is null)),
    ('v1_cards_on_row', (select count(*) from mv_cards where on_row)),
    ('v2_cards', (select count(*) from public.srs_cards_v2)),
    ('v2_cards_merged_from', (select coalesce(sum(n - 1), 0) from mv_merged)),
    ('v2_cards_clamped', (select count(*) from mv_merged where interval_days > 36500)),
    ('v1_opening_progress', (select count(*) from public.opening_progress)),
    ('v2_course_progress', (select count(*) from public.course_progress))
  on conflict (k) do update set v = excluded.v, at = now();

  -- ── swap: v1 tables become backups (kept), v2 tables take their names ─────
  alter table public.srs_cards rename to srs_cards_v1_backup;
  alter table public.srs_cards_v2 rename to srs_cards;
  alter index if exists public.srs_cards_v2_due_idx rename to srs_cards_due_v2_idx;
  alter table public.opening_progress rename to opening_progress_v1_backup;
  alter table public.quiz_challenges rename to quiz_challenges_v1_backup;
  -- backups are read-only history: no client access
  revoke all on public.srs_cards_v1_backup, public.opening_progress_v1_backup, public.quiz_challenges_v1_backup
    from anon, authenticated;

  -- ── staging tables are done ──────────────────────────────────────────────
  drop table public.legacy_row_answers_v1;
  drop table public.legacy_answers_v1;
  drop table public.legacy_openings_v1;
end $$;

commit;
