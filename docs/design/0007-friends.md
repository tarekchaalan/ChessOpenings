# ADR 0007 — Friends (follow, profiles, shared progress)

- **Status:** proposed (Phase 0, 2026-10-19). Waiting on the owner's decisions (listed at the end). No code or migration has been written.
- **Spec:** `docs/prompts/friends.md`.
- **Builds on:** ADR 0004 (server-graded writes), ADR 0006 (linked accounts and game summaries).

## Context

What exists today, and what it means for this feature:

| Piece | Where | Consequence |
|---|---|---|
| `profiles(id, username, rating, attempts, correct, created_at)` | 0001, 0002 | RLS `select using (true)`, granted to `anon`. **Every user's trainer rating, attempts and correct count can already be read by anyone over the REST API**, not only the top 100 on the board. See Decision 4. |
| `leaderboard_global` / `leaderboard_weekly` | 0001 views (owner rights) | Top 100 only, `attempts ≥ 10` (global) / `≥ 5` this week (weekly). A friend outside the top 100 isn't in these views, so the Friends filter needs its own query (below). |
| `course_progress(seen, correct, streak, best_streak, mastery, last_line_id, updated_at)` | 0004 | `seen` / `correct` are server-graded. `mastery` is **client-reported** (`/api/train/progress`), display only. `streak` is a run of correct answers, not days. |
| `quiz_attempts(user_id, course_id, line_id, correct, created_at, …)` | 0001 + 0004 | Server-written by `train_commit`. The only server record of *which lines* a player trained and *which days* they played. |
| Per-line "learned" (`learnedAt`) | `src/lib/progress/store.ts` | **Client-only.** The server can't tell "learned 3 new lines"; see Stats definitions. |
| `daily_streak()` | 0001 | UTC days with an attempt, for `auth.uid()` only. Friends needs the same for another user, inside a definer function. |
| `linked_accounts(…, ratings jsonb, visibility, …)`, `game_summaries` | 0006 | **The tables exist, but nothing writes them yet.** Insights Phases 1–3 (`src/lib/insights`, `/api/insights/*`, the linking UI) haven't shipped: `src/lib/insights/` holds only fixtures. See Decision 1. |
| `linked_accounts.visibility` (`private`/`friends`/`public`) | 0006 | Reserved for this feature, read by nothing. Overlaps the per-section settings; see Decision 5. |
| ADR 0006 trust note | ADR 0006 "Write path" | Linked ratings and summaries are client-derived and can be forged by their owner. Usernames are typed, not proven (`verified` is false for every Chess.com link). Friends must label them "imported" / "unverified", or re-fetch server-side. |
| Write convention | ADR 0004 | Clients only `SELECT` their own rows. Writes go through route handlers with the service role, or SECURITY DEFINER RPCs that read `auth.uid()` (`ensure_profile`). |
| Account deletion | `/api/account` | Deletes `auth.users`; everything cascades through `profiles`. |
| Rate limiting | `lib/server/train.ts` | Counts rows in the table being written (`challengesSince`). There's no generic limiter. |
| Local SQL tests | `scripts/supabase/local-pg.sh`, `test-0006.sh` | Plain Postgres 16 + `local-shim.sql`; refuses non-local hosts. `test-0007` follows the same pattern. |
| e2e | `e2e/` | No signed-in flows today and no local Supabase stack (Docker exists in this container; the Supabase CLI doesn't). See Testing. |
| Username index | `profiles_username_lower_key` on `lower(username)` | A unique btree under the database collation. **It can't serve `LIKE 'abc%'`** unless the collation is C, so prefix search needs a `text_pattern_ops` index. |

## Decision 1 — Insights isn't shipped; build order

The prompt's stop condition is "tables missing". They aren't missing, but they are empty in production: no code writes them. Ratings, "Openings they play", rating feed events and the Challenge button all read them.

| Option | Pros | Cons |
|---|---|---|
| **A. Build Friends now; Insights-backed parts are complete and tested but stay invisible until Insights ships (recommended)** | Follow, privacy, profiles, feed (training events), friends board and compare all work on data that exists. SQL and e2e tests seed `linked_accounts` rows directly, so Challenge and Ratings are tested end to end. A hidden or empty section renders nothing (spec 2.3), so nothing looks broken. | Ratings and Challenge ship dark. "Done when: Challenge…" is met in tests, not by real users, until Insights lands. |
| B. Ship Insights Phases 1–3 first | Friends launches complete. | Delays the whole feature behind a separate, larger run. |

**Recommendation: A.** What would change it: wanting Challenge live on launch day.

## Decision 2 — Follow model

One-way follow, as proposed. **Friends = mutual active follows.**

- `follows.status`: `active` | `pending`.
- **Approve followers** (`privacy_settings.approve_followers`, default **off**). When on, a new follow is `pending` until the followee accepts (→ `active`) or declines (row deleted, follower not told).
- **A pending follower is a stranger** for every visibility check, the feed and the friends board. Only `active` rows count anywhere.
- Turning approval **on** leaves existing followers alone. Turning it **off** leaves pending requests pending; the Requests tab stays visible while any exist.
- **Remove follower:** deletes the edge. They can follow again (or request again, when approval is on).
- **Unfollow** a pending request = cancel it.

### What "Followers" protects

With approval off, anyone with an account can follow anyone, so **Followers ≈ every signed-in user who clicks Follow**. The Privacy settings say so next to the option ("Anyone can follow you unless *Approve followers* is on"). Followers becomes a real boundary only with approval on. That's why the defaults (Decision 3) never use Followers.

## Decision 3 — Visibility

Five audiences, one enum, ordered: `everyone` > `followers` > `friends` > `only_me`.

- **Everyone** includes signed-out visitors: the profile link is shareable (spec 2.4).
- **Followers** = active followers (a mutual friend is also a follower).
- **Friends** = active follows in both directions.
- **Only me** = the owner.

Sections, each with its own setting:

| Section | Covers | Governed by |
|---|---|---|
| `ratings` | Linked usernames, platform ratings, **"Openings they play"** (Insights game summaries), the Challenge button | one setting (spec lists ratings and usernames together; played openings are the same imported data) |
| `learning` | Courses in progress, mastery, per-course accuracy, "Learn this too" links, Compare | |
| `stats` | Daily streak, lines practised, reviews this week, overall accuracy | |
| `activity` | Feed items | **and** the item's own section: see Feed |

Not settings (always public, as today): username, follower/following **counts**, the global leaderboard entry, the trainer rating (already public, Decision 4).

**Follower and following *lists*** are visible only to their owner in this run (the Following / Followers tabs on your own `/friends`). Showing other people's lists would need a sixth setting; it's left out.

### Proposed defaults (owner decides)

The ground rule is "nothing becomes visible that wasn't visible before without the player choosing it". Today none of these four sections is visible to anyone, so:

| Section | Default |
|---|---|
| ratings | **Only me** |
| learning | **Only me** |
| stats | **Only me** |
| activity | **Only me** |
| approve followers | off |

The empty-profile problem is handled with a choice, not a default. The first time a player opens `/friends` or their own profile, a card says "Choose what people can see" with one-click presets:
- **"Friends"**: all four sections → Friends (mutual).
- **"Everyone"**: all four → Everyone.
- **Customize**: opens Settings → Privacy.

Dismissing it keeps Only me.

Rejected alternative: default Friends (mutual). A mutual follow is easy to get with approval off (follow back), and following someone isn't consent to share. It breaks the ground rule.

## Decision 4 — The trainer stats already in `profiles`

`attempts` and `correct` (overall accuracy) are world-readable today through `profiles`. A **Stats: Only me** setting would then be false for accuracy.

- **Recommended:** in 0007, replace the table-wide `select` grant on `profiles` for `anon` / `authenticated` with a column grant on `(id, username, rating, created_at)`.
  - Rating stays public: it's the leaderboard score.
  - The leaderboard views are unaffected (they run with owner rights).
  - Own-row readers move off those columns: `/api/progress` reads `rating, attempts, correct` with the user-scoped client today, and switches to a `my_profile()` definer RPC (own row only). `AuthProvider` reads `username` only, so it keeps working.
  - The top 100 still show attempts and correct on the board. That's the "existing global leaderboard entry stays public" rule.
- Alternative: keep the grant and document that overall accuracy is public. Then the Stats section can only hide streak, lines and reviews.

## Decision 5 — `linked_accounts.visibility`

It overlaps `privacy_settings.ratings`, and nothing reads it. **Recommended: drop the column in 0007**, leaving one source of truth. A per-platform override (show Lichess, hide Chess.com) can come back later as a nullable column that narrows the section setting.

## Blocking

- `blocks(blocker_id, blocked_id)`. Blocking, in one transaction:
  - deletes follows in both directions (pending included);
  - deletes notifications between the two;
  - makes every cross-user function treat the pair as non-existent.
- **"Hidden everywhere" means every surface that has a viewer:**
  - the profile (`/u/x` answers exactly like a non-existent user: "This profile isn't available");
  - search, the feed, follow/request lists, the friends board, Compare, Challenge;
  - notifications.
- **Two places a block can't hide:**
  - **The global leaderboard and the `profiles` username column.** They are public to signed-out visitors, so hiding them from a signed-in blocked user would only mean logging out. A block hides profile *sections*, not existence.
  - **Detectability.** A blocked user who compares their view with a signed-out one can infer the block. Same as Instagram. The block is never announced.
- Follow / request RPCs against a blocked pair answer `not_found`, the same as a missing username.
- Unblocking restores nothing.
- A block applies both ways: neither side can see or follow the other, whoever blocked.

## How cross-user reads are secured

- **Every table:** RLS on. Defaults revoked from `public, anon, authenticated` first (as 0004/0006, so there's no client `TRUNCATE`). No client `insert`/`update`/`delete` grant on any 0007 table.

| Table | Client `select` policy |
|---|---|
| `follows` | Rows where you're `follower_id` or `followee_id` |
| `blocks` | Rows where you're `blocker_id` (a blocked user never sees the row) |
| `privacy_settings` | Own row |
| `notifications` | Own rows (`user_id = auth.uid()`) |
| `activity_events` | Own rows |
| `rate_counters` | None |

- **One visibility function**, internal only (execute revoked from clients, so nobody can probe relationships by passing someone else's id as the viewer):

  ```sql
  can_view(p_viewer uuid, p_owner uuid, p_section section) returns boolean
  -- p_viewer = p_owner                      → true
  -- block in either direction               → false   (blocks win)
  -- p_section = 'public'                    → true    (username, counts, board)
  -- setting = everyone                      → true    (p_viewer may be null = signed out)
  -- setting = followers                     → active follow viewer→owner
  -- setting = friends                       → active follows both ways
  -- else                                    → false
  -- a missing privacy_settings row reads as the defaults
  ```

  `section` is an enum: `ratings, learning, stats, activity, public`. The `public` pseudo-section exists so search and the friends board go through the same function and get the block check.

- **Client-facing SECURITY DEFINER functions**, `search_path = public, pg_temp`. Each takes the viewer from `auth.uid()`, never from a parameter, and calls `can_view` for each section it returns.

  | Function | Grants | Returns |
  |---|---|---|
  | `profile_view(p_username)` | anon, authenticated | Header plus only the sections the viewer may see, as one `jsonb`, and a `has_hidden` flag for the one "Some of this profile is private" line. Null for a missing or blocked user. |
  | `profile_preview(p_audience)` | authenticated | The caller's **own** profile as `everyone` / `follower` / `friend` would see it ("view as"). Only for the caller's own id, so it can't be used to escalate. |
  | `search_profiles(p_prefix)` | authenticated | ≤ 20 usernames + relationship. Rate limited. |
  | `friends_feed(p_before, p_limit)` | authenticated | Visible feed items. |
  | `leaderboard_friends(p_board)` | authenticated | Global or weekly scores for you + active followees. |
  | `compare_with(p_username)` | authenticated | Side-by-side for shared courses and platforms, each side gated by `can_view`. |
  | `challenge_targets(p_username)` | authenticated | Platforms + both usernames and ratings (Challenge, below). |
  | `my_profile()` | authenticated | Own rating / attempts / correct (Decision 4). |
  | `follow`, `unfollow`, `respond_request(p_follower, p_accept)`, `remove_follower`, `block`, `unblock`, `set_privacy(…)`, `mark_notifications_read()` | authenticated | The write path. Each one checks blocks, self-follow, approval and rate limits in the database. |

- **Why RPCs, not route handlers** (a deviation from ADR 0004's route pattern). Every rule here is relational: blocks, approval, mutual follows. Keeping it in SQL means the policy tests cover the whole write path, with no second implementation in TypeScript. Nothing here is forgeable the way grading was, because a follow carries no score.
- **Data honesty on others' screens** (ADR 0006 trust note):
  - Platform ratings show "from Lichess · synced <date>", plus "unverified" when `verified` is false, and link to the player's profile on that platform so anyone can check.
  - Mastery is labelled as the player's own estimate. Accuracy and lines come from server-graded attempts.

## Stats definitions (server-side, what can honestly be computed)

| Shown as | Definition |
|---|---|
| Daily streak | Consecutive UTC days with ≥ 1 `quiz_attempts` row, ending today or yesterday. `daily_streak()`'s rule, factored into `streak_of(user)`. UTC matches the client's `streak()` in `progress/stats.ts`. |
| **Lines practised** (not "learned") | Distinct `(course_id, line_id)` with ≥ 1 correct attempt. The server doesn't know `learnedAt` (client-only); calling it "learned" would claim more than the data holds. Alternative: send `learnedAt` through `/api/train/progress`, but that is client-reported again. |
| Reviews this week | `quiz_attempts` since `date_trunc('week', now())`, the weekly board's window. |
| Accuracy | `correct / attempts` from `profiles` (overall); `correct / seen` from `course_progress` (per course). |
| Learning now | `course_progress` rows updated in the last 30 days, newest first, with mastery (labelled) and accuracy. Links to the course page from `course_id` (`hub/system@side` → `/openings/hub/system/side`). |

## Feed

### Generation

- **Writers:** triggers only, owned by the table owner. `activity_events` has no client write grant.
- **Shape:** `activity_events(user_id, kind, bucket text, payload jsonb, created_at, updated_at)`, unique `(user_id, kind, bucket)`.
- **Idempotent and collapsing:** every writer is an `insert … on conflict (user_id, kind, bucket) do update`. A re-sync or a retried trigger can't duplicate, and a burst lands in one row.

| Kind | Trigger | Bucket | Payload | Rendered |
|---|---|---|---|---|
| `lines` | `after insert on quiz_attempts`, when `correct` and it is the user's first correct attempt on `(course_id, line_id)` | `course_id:UTC date` | `{course_id, n}` (n incremented) | "Sam practised 3 new lines in the Italian" |
| `streak` | Same trigger, first attempt of a UTC day, when `streak_of` hits a milestone (3, 7, 14, 30, then every 50) | `streak:<n>:<start date>` | `{days}` | "Sam reached a 14-day streak" |
| `rating` | `after update of ratings on linked_accounts`, per time class | `platform:time_class:ISO week` | `{platform, time_class, from, to}`. `from` is kept on conflict (the week's first value); `to` is overwritten. | "Sam's Lichess blitz rating is up 40 this week". Shown only when \|to − from\| ≥ 20. |

- Follows, blocks and settings changes generate **no** events.
- **Retention:** events older than 90 days are pruned, opportunistically by the trigger (1 in 100 inserts deletes ≤ 500 old rows) instead of a cron job.

### Reading

`friends_feed` returns events from **users the viewer actively follows**, newest `updated_at` first, last 30 days, keyset-paginated. An item is shown only when `can_view(viewer, owner, 'activity')` **and** `can_view` on its subject section:
- `lines` → learning;
- `streak` → stats;
- `rating` → ratings.

Visibility is checked **at read time**, so tightening a setting hides past items immediately.

The pure part (grouping same-owner items within a day, the rendered strings, the ±20 threshold) lives in `src/lib/friends/feed.ts`, test-first.

## Leaderboard "Friends" filter

`leaderboard_friends('global' | 'weekly')` = the viewer plus active followees, minus blocked pairs, with the **same score expressions** as the two views.
- Global: `rating desc, attempts desc`.
- Weekly: sum of rating deltas since `date_trunc('week', now())`.
- Ranks are within the filtered set. Rows under the views' thresholds (`attempts < 10`, `< 5` weekly) are shown greyed with "not ranked yet" instead of being dropped, since a friends board of 3 shouldn't lose people.
- The scores are public already (Decision 4), so no section gate beyond `public` (blocks).

## Challenge a friend

- `challenge_targets(friend)` returns the platforms where:
  - both players have a `linked_accounts` row;
  - `can_view(viewer, friend, 'ratings')` holds;
  - neither has blocked the other.

  For each it returns both stored usernames and ratings. The viewer's own usernames don't need their own setting: it's their data.
- The client builds the URL in a pure, tested `challengeUrl(platform, username)` with `encodeURIComponent`, only from the username the RPC returned.
- **None** → no button. **One** → a button labelled "Challenge on Lichess (DrNykterstein)" that opens it in a new tab. The username is in the label because links are unverified: a friend could have linked someone else's name. **Two** → the dialog from spec 2.7.
- Shown on the profile and in the Following list. It isn't restricted to mutual friends; the ratings setting is the gate.

### URL verification (2026-10-19, from this container)

| URL | Result | Status |
|---|---|---|
| `https://www.chess.com/play/{u}` | `302` → `https://www.chess.com/play/online/new?isInvited=1&opponent={u}` | **Verified (HTTP)**: redirects to a new-game page with the opponent prefilled. Whether the page then sends the invite to that member needs a signed-in browser check. |
| `https://lichess.org/?user={u}#friend` | `403`, Cloudflare `cf-mitigated: challenge` (all of lichess.org, including `/@/{u}`) | **Not verified**: the container is bot-challenged. The fragment is handled by client JS, so even a 200 wouldn't prove the dialog opens. Needs a browser check. |

**Owner, manually** (I can't run real phones):

| Device | App installed? | Lichess link opens | Chess.com link opens |
|---|---|---|---|
| iPhone | yes | | |
| iPhone | no | | |
| Android | yes | | |
| Android | no | | |
| Desktop browser, signed in | — | | |

**Fallback**, if a URL turns out not to work: open the friend's profile on that platform (`lichess.org/@/{u}`, `chess.com/member/{u}`), and the dialog says "Open their profile to challenge them". Chess.com `/member/{u}` returned 200.

Phase 5 (Lichess OAuth, `POST /api/challenge/{username}`) stays optional and needs a separate ask.

## Notifications

`notifications(id, user_id → recipient, actor_id, kind: follow | request | accepted, created_at, read_at)`.

- **Not a view over `follows`:** a view can't hold "seen", and an accepted request is an event on the *requester's* side.
- Unique `(user_id, actor_id, kind)`. Follow → unfollow → follow churn upserts one row (`created_at = now(), read_at = null`) instead of stacking.
- Written by the follow RPCs.
- **Badge:** `count(*) where read_at is null`, polled on focus and every 60 s. Opening `/friends` calls `mark_notifications_read()`. No realtime channel, no email.
- Removed when the follow is undone before it's read, and on block.

## Abuse limits

`rate_counters(user_id, action, window_start, n)`, primary key `(user_id, action, window_start)`, cascade from `profiles`. Each limited RPC increments its counter atomically and raises `rate_limited` (mapped to a 429-style message) over the cap. Counting a separate table, not `follows`, means unfollow/re-follow churn can't reset the count.

| Action | Cap |
|---|---|
| follow (incl. requests) | 60 / hour |
| search | 30 / minute |
| block + unblock | 30 / hour |

- Stale windows are pruned by the same opportunistic delete.
- Signed-out `profile_view` has no per-user limit; it relies on Supabase's platform limits. It returns only Everyone sections, which are public by choice.

## Deletion

- Every 0007 table references `profiles(id) on delete cascade`, on **both** user columns: `follows` (follower and followee), `blocks` (both), `notifications` (`user_id` and `actor_id`), `privacy_settings`, `activity_events`, `rate_counters`.
- So `DELETE /api/account` removes every row about the account in both directions, with no route change.
- `test-0007` deletes one of two linked users and asserts zero remaining rows that mention them in every table.

## Indexes, expected sizes and plans

**Assumption:** sized for 10k accounts, an average of 20 follows each, about 3 events per active user per day, 90-day retention. Real `EXPLAIN (ANALYZE)` output on a seeded local DB (10k users, 200k follows, 300k events) is recorded here in Phase 1. Below are the intended plans.

| Query | Rows | Index | Intended plan |
|---|---|---|---|
| `can_view`: follow edge lookups | 200k `follows` | PK `(follower_id, followee_id)` | 2 index lookups |
| `can_view`: block check | ~1k `blocks` | PK `(blocker_id, blocked_id)` + `(blocked_id, blocker_id)` | 2 index lookups |
| Followers list / counts | | `follows (followee_id, status)` | Index scan; counts are index-only |
| Feed | 300k `activity_events` | `activity_events (user_id, updated_at desc)` | Nested loop: viewer's followees (PK prefix) → top-N per followee, merge, limit 30 |
| Search | 10k `profiles` | **new** `profiles (lower(username) text_pattern_ops)` | Index range scan `≥ 'ab' and < 'ac'`, limit 20 |
| Badge | | `notifications (user_id) where read_at is null` | Partial index-only count |
| `lines` trigger's "first correct on this line" | `quiz_attempts` (largest table) | **new** `quiz_attempts (user_id, course_id, line_id) where correct` | One index probe per graded answer |
| `streak_of` | | Existing `quiz_attempts_user_created_idx` | ≤ streak-length index probes |
| Friends board | 21 rows | PKs above + `profiles` PK | Nested loop |

The extra index on `quiz_attempts` costs write time on every graded answer. That's the price of server-side "lines practised"; Phase 1 measures it.

## Testing

- **Pure logic, test-first (Vitest)**, in `src/lib/friends/`:
  - `visibility.ts`: the same resolution table as `can_view`, used for the "view as" labels and the settings copy;
  - `feed.ts`: grouping, strings, thresholds;
  - `compare.ts`: the shared-course and shared-platform join, the deltas;
  - `challenge.ts`: platform choice and URL encoding, including hostile usernames.
- **SQL (`scripts/supabase/test-0007.sh` / `.sql`)**, local Postgres only, applying 0001–0007 then 0007 again (idempotence). The policy matrix:
  - **Viewers:** owner, active follower, pending follower, mutual friend, stranger (signed in), blocked by owner, owner blocked them, anonymous.
  - **Sections:** ratings, learning, stats, activity, played openings, challenge targets, search, friends board, feed, follow lists, raw table reads.
  - **Settings:** each of the 4 levels.

  The test asserts every cell, prints the matrix with pass counts, and also asserts:
  - client `insert/update/delete/truncate` are denied on every 0007 table;
  - `can_view` isn't executable by clients;
  - the profiles column grant (Decision 4);
  - the cascade on account deletion.
- **e2e:** the spec asks for two signed-in users. No local Supabase stack runs in e2e today.
  - **Recommended:** add a `supabase start` (Docker + Supabase CLI) e2e project, `friends.spec.ts`, that creates two users through the auth admin API in `global-setup`. It runs real RLS and RPCs, asserts challenge URLs without opening them, and runs axe AA in light and dark.
  - The existing specs keep running without it.
  - Cost: Docker in CI.
  - Fallback: mock the RPCs with `page.route`. Cheaper, but then the e2e tests only prove the UI, and the SQL suite carries all the security proof.

## UI (Phases 2–4, constraints only)

- **Routes:**
  - `/u/[username]`: profile; "view as" on your own.
  - `/friends`: Following, Followers, Requests (when approval is on or any are pending), Search, Feed, Compare.
  - Settings gets a **Privacy** tab (signed in only), next to Account / Preferences / Data.
- **Header:** a "Friends" nav item with the unread badge (`aria-label="Friends, 2 new"`).
- **Leaderboard:** a third segment, "Friends", beside Global / Weekly, signed in only. Usernames on the board link to profiles.
- **Accessibility:**
  - Menus and dialogs are keyboard-operable with focus return.
  - The badge count is announced politely.
  - Nothing animates under reduced motion.
  - Phone width: lists become cards; no horizontal scroll.
- **Guests:** nothing changes. Follow buttons, the Friends tab and Privacy show only when signed in. A signed-out visitor can open a profile and sees Everyone sections plus "Sign in to follow".

## Phases

| Phase | Deliverable |
|---|---|
| 0 (this) | This ADR. |
| 1 | `0007_friends.sql`, `can_view`, RLS, RPCs, triggers, `test-0007` with the matrix and `EXPLAIN` numbers, the `my_profile` switch in `/api/progress`. |
| 2 | Follow / request / block / remove UI, Privacy tab with presets, `/u/[username]` with "view as". |
| 3 | Search, `/friends`, feed, badge. |
| 4 | Compare, friends board, Challenge (links), e2e + axe. |
| 5 (ask first) | Lichess OAuth + direct challenges. |

## Decisions needed from the owner

1. **Build order:** A (Friends now, Insights-backed parts dark until Insights ships), or B (Insights first)?
2. **Defaults:** all four sections Only me, plus the presets card? Or different defaults?
3. **Profiles exposure:** restrict `attempts` / `correct` to a column grant (recommended), or accept that overall accuracy stays public?
4. **`linked_accounts.visibility`:** drop it (recommended)?
5. **"Openings they play"** shares the Ratings setting, rather than a fifth setting. OK?
6. **"Lines practised"** (server-graded) in place of "lines learned". OK?
7. **Writes through SECURITY DEFINER RPCs** rather than route handlers. OK?
8. **e2e:** a local Supabase stack with real users (recommended), or RPC mocks?
9. **Caps:** 60 follows/h, 30 searches/min, 30 block ops/h. OK?
10. **Manual checks:** the device table under Challenge, and the Lichess `#friend` URL in a desktop browser.
