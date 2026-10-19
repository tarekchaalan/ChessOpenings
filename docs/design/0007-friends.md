# ADR 0007 — Friends (follow, profiles, shared progress)

- **Status:** proposed (Phase 0, 2026-10-19). Waiting on the owner's decisions under "Open decisions". No code or migration exists yet.
- **Spec:** `docs/prompts/friends.md`.
- **Builds on:** ADR 0006 (Account Insights). Its tables `linked_accounts` and `game_summaries` exist (`0006_account_insights.sql`), so the prerequisite in spec §0 is met.

## Context

What exists and what this feature has to respect:

| Piece | Where | What it means here |
|---|---|---|
| `profiles(id, username, rating, attempts, correct)` | 0001, 0005 | Select policy is `using (true)` for `anon` and `authenticated`. **Every column, including `id`, is already public.** Usernames are unique ignoring case (`profiles_username_lower_key`). |
| `leaderboard_global`, `leaderboard_weekly` | 0001 | Owner-run views over `profiles` / `quiz_attempts`, granted to `anon`. They stay public (spec §2.2). |
| `course_progress(user_id, course_id, seen, correct, streak, best_streak, mastery, last_line_id, updated_at)` | 0004 | Own-row select. `seen` / `correct` are written by `train_commit` (server-graded). **`mastery` is client-reported** through `/api/train/progress` (display only). |
| `quiz_attempts(user_id, created_at, correct, course_id, line_id, …)` | 0001, 0004 | Written only by `train_commit`, so it can't be forged. Index `(user_id, created_at desc)`. |
| `srs_cards` | 0004 | Own-row select. Not exposed to anyone else by this feature. |
| `linked_accounts(…, ratings jsonb, visibility, …)`, `game_summaries` | 0006 | Own-row select. `visibility` (`private` / `friends` / `public`) was reserved for this feature; **nothing in `src/` or `scripts/` reads it** (grep, 2026-10-19). Links are unverified: anyone can link any public username. |
| Write convention | ADR 0004, 0006 | Clients only `SELECT` their own rows. Writes go through `withSupabase` routes plus the service role, or through `SECURITY DEFINER` RPCs that read `auth.uid()` (`ensure_profile`, `username_available`). |
| Account deletion | `/api/account` | Deletes `auth.users`; everything cascades through `profiles`. |
| Streak and "lines learned" on the dashboard | `lib/progress/stats.ts`, `lib/progress/store.ts` | Computed **in the browser** from localStorage. `learnedAt` (finished Learn mode) never reaches the server. The server only has `quiz_attempts` and `course_progress`. |
| Local SQL test harness | `scripts/supabase/local-pg.sh`, `local-shim.sql`, `test-0006.sh` | Postgres 16 on 127.0.0.1, refuses other hosts. The new test follows the same shape. |

**Migration number.** The spec says `0007_...sql`, but `0007_insights_sync_claim.sql` already exists. This feature uses **`0008_friends.sql`**. The ADR keeps the number 0007, which is free under `docs/design/`.

## Decision 1 — Follow model

**One-way follow** (Lichess / Twitter), as the spec proposes.

- `follows(follower_id, followee_id, status, created_at)`, primary key on the pair, `check (follower_id <> followee_id)`, `status in ('active', 'pending')`.
- **Friends** = an `active` follow in both directions. Nothing else creates a friendship.
- **Approve followers** (`privacy_settings.approve_followers`, default **off**):
  - Off: `follow()` inserts `active`.
  - On: `follow()` inserts `pending`. The followee accepts (→ `active`) or declines (row deleted). A pending follow grants nothing: it counts as "not a follower" in every check.
  - Turning approval **on** keeps existing followers.
  - Turning it **off** leaves pending requests pending; they stay in the Requests tab until handled. Accepting them all at once would make data visible without a decision.
- **Unfollow** deletes the row (active or pending; cancelling a request is the same call).
- **Remove follower** deletes the follower's row towards me. They aren't told and can follow again (or request, if approval is on). Block is the way to stop that.
- **Block** (Decision 4) deletes follows both ways and prevents new ones.

## Decision 2 — Sections, audiences and visibility resolution

### Audiences

For a viewer `V` and an owner `O`, exactly one applies, checked in this order:

1. `V = O` → **owner**: sees everything.
2. A `blocks` row exists in either direction → **blocked**: sees nothing, and `O` doesn't exist for `V` (Decision 4).
3. `V` is anonymous → **anonymous**: only sections set to Everyone.
4. Active follows both ways → **friend** (also a follower).
5. `V → O` is active → **follower**.
6. Otherwise → **stranger** (signed in). A pending follower is a stranger.

### Levels

`everyone > followers > friends > only_me`. A section is visible when the viewer's audience reaches its level:

| Section level ↓ / audience → | owner | friend | follower | stranger | anonymous | blocked |
|---|---|---|---|---|---|---|
| everyone | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| followers | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| friends | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ |
| only_me | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |

This table is the test matrix: 4 levels × 6 audiences × 4 sections = **96 cases**, run in SQL against the real function and in Vitest against the TypeScript mirror, both from one fixture file (`src/lib/friends/__tests__/visibility-matrix.json`), so the two can't drift.

### Sections (Settings → Privacy)

| Section | What it shows | Source |
|---|---|---|
| `linked` — **Linked accounts** | Lichess / Chess.com usernames, ratings per time class, **and "Openings they play"** | `linked_accounts`, `game_summaries` |
| `learning` — **Openings I'm learning** | Courses in progress, server-counted answers per course, client-reported mastery | `course_progress` |
| `stats` — **Training stats** | Streak, lines trained, graded moves this week (definitions below) | `quiz_attempts` |
| `activity` — **Activity in the feed** | Feed items | `activity_events` |

- **"Openings they play" is folded into `linked`** (the spec lists it on the profile but gives it no setting). It comes from the same games and points at the same accounts, so a separate switch would allow "username hidden, opening repertoire and results shown", which identifies the account anyway. Open decision 3.
- **The Challenge button follows `linked`**, as the spec requires.
- **Feed items need two sections.** An item is visible only when `activity` **and** the section it reveals are visible: a rating item also needs `linked`, a lines item `learning`, a streak item `stats`. So the feed can never leak what the profile hides.
- **Already public, and staying so** (spec §2.2): username, app rating, attempts and correct answers (that is, app accuracy) through `profiles` and the global board. The `stats` section therefore doesn't claim to hide accuracy; the Settings copy says "Your username, app rating and accuracy are always public (leaderboard)."

### Server definitions of the stats

The dashboard's numbers come from localStorage, which the server can't see. Profiles show server numbers, named for what they count:

| Profile label | Definition | Why not the dashboard's |
|---|---|---|
| **Day streak** | Consecutive UTC days with ≥ 1 row in `quiz_attempts`, ending today or yesterday | Same rule and UTC day keys as `stats.ts`, but over server rows. Answers made while signed out don't count. |
| **Lines trained** | Distinct `(course_id, line_id)` with ≥ 1 correct server-graded answer | `learnedAt` (finished Learn mode) never reaches the server. "Learned" would overclaim. |
| **Graded moves this week** | `quiz_attempts` since Monday 00:00 UTC | The server can't tell a review from a first pass. |
| **Accuracy** | `profiles.correct / attempts` | Already public; shown for completeness. |

### Defaults (owner decides; spec §2.2)

The ground rule is "nothing becomes visible to others that wasn't visible before without the player choosing it". Today nothing past the username and the board is visible, and a mutual follow is a choice to connect, not a choice to share data.

- **Proposal A (recommended): every section starts at Only me**, matching `linked_accounts.visibility = 'private'`. The first time a player follows someone, or accepts a request, a one-step card offers a preset: "Let friends see what I'm learning, my training stats and my activity" (`learning`, `stats`, `activity` → Friends; `linked` stays Only me). Skip keeps everything private. The card also sits on `/friends` until answered.
- **Proposal B:** `learning`, `stats`, `activity` default to Friends; `linked` to Only me. The feature works with no setup, but it breaks the ground rule for existing accounts.
- **Proposal C:** A for existing accounts, B for accounts created after the migration, with the choice shown at sign-up.

A is the only one that meets the ground rule as written. B would change if the rule is meant to cover strangers only, since Friends needs a mutual follow either way.

### `linked_accounts.visibility`

One switch per section means this column becomes a second, conflicting control. **Proposal:** drop it in 0008 (nothing reads it; it's `private` everywhere). The alternative is per-platform visibility (show Lichess, hide Chess.com) under the section switch, which the spec doesn't ask for. Open decision 4.

## Decision 3 — Cross-user reads go through the database

**No table grants another user's rows to anyone.** All existing own-row policies stay as they are. Every cross-user read is a `SECURITY DEFINER` function that:

- takes the viewer from `auth.uid()`, **never from a parameter**;
- resolves the audience once with `audience(viewer, owner)` and checks each section with `can_view(viewer, owner, section)`;
- returns only the visible parts, and `null` when the owner is blocked either way or doesn't exist (the two are indistinguishable);
- has `set search_path = public, pg_temp` and an explicit `grant execute` (0001 already revokes the default from `public` / `anon`).

`audience()` and `can_view()` themselves are **not** granted to clients: with a viewer parameter they would let anyone probe who follows whom.

| Function (client-callable) | Grants | Returns |
|---|---|---|
| `get_profile(p_username, p_view_as default null)` | anon, authenticated | Header (username, counts, relationship flags: following / requested / follows you / friends), then each visible section, and `some_private boolean`. `p_view_as in ('everyone', 'follower', 'friend')` works only when the caller is the owner (the "view as" preview); for anyone else it's ignored. |
| `search_profiles(p_prefix)` | authenticated | ≤ 20 `{username, following, friends}`. Prefix of 2–20 chars matching the username alphabet, case-insensitive. Excludes blocks both ways and the caller. Rate limited. |
| `my_follows(p_kind)` | authenticated | `following` / `followers` / `requests`: usernames and flags. Only the caller's own lists. **Other players' lists are never exposed**, only their counts. |
| `get_feed(p_before default null, p_limit default 30)` | authenticated | Events of players the caller follows (active), newer than 30 days, filtered per Decision 2. |
| `compare_with(p_username)` | authenticated | The caller's own learning and ratings next to the friend's **visible** sections only. |
| `friends_leaderboard()` | authenticated | The caller plus active followees, minus blocks, with `rating`, `attempts`, `correct` and the same rank order as `leaderboard_global`. No section gating, because those numbers are already public. |
| `challenge_targets(p_username)` | authenticated | Platforms where both have a linked account, the friend's `linked` is visible to the caller, and there's no block: `{platform, my_username, my_rating, their_username, their_rating}`. Folded into `get_profile` for the button; also called by the Following list. |
| `notification_count()` / `my_notifications()` / `mark_notifications_read()` | authenticated | The badge and its list (Decision 6). |

Writes are RPCs too (Decision 5), so every check lives in one place and the SQL tests cover the real paths.

**Anonymous visitors** can open `/u/[username]` (spec §2.4, a shareable link) and see Everyone sections only. They can't search, follow, see feeds or lists.

## Decision 4 — Blocking

`blocks(blocker_id, blocked_id, created_at)`, primary key on the pair, no self-block.

- `block(p_username)` in one transaction: insert the block, delete `follows` both ways (active and pending), delete `notifications` between the two.
- **Hidden both ways, everywhere this feature reads:** `get_profile` returns `null` (same as "no such user"), `search_profiles` omits them, `get_feed` drops their events, `friends_leaderboard` and `my_follows` exclude them, `challenge_targets` returns nothing.
- **New follows are refused** in either direction with the same error as an unknown username, so the blocked player isn't told.
- **Not hidden:** the global and weekly leaderboards, which stay public by the spec. A blocked player can still see the blocker's name there and notice that the profile "doesn't exist". This is the one known tell; hiding it would mean a per-viewer global board.
- `unblock(p_username)` deletes the row. Follows don't come back.
- Settings → Privacy lists the caller's blocks (own-row select on `blocks` where `blocker_id = auth.uid()`). Nobody can read rows where they are `blocked_id`.

## Decision 5 — Write path: RPCs, not routes

Spec §4 allows either. **RPCs** called with the user's JWT:

`follow(p_username)`, `unfollow(p_username)`, `accept_follower(p_username)`, `decline_follower(p_username)`, `remove_follower(p_username)`, `block(p_username)`, `unblock(p_username)`, `set_privacy(p_settings jsonb)`.

Why not `/api/*` routes plus the service role, the pattern for train and insights:

- Those routes exist because the server must *validate content* (theory edges, replayed plies) in TypeScript. Social writes have no content to validate; the checks are relational (blocks, approval, limits) and belong next to the data.
- Fewer moving parts: no service-role code path for social writes, and the SQL tests exercise the real thing.
- `privacy_settings` gets no client write grant; `set_privacy` validates the enum values and upserts.

## Decision 6 — Notifications (badge only)

A table rather than a view over `follows`, because "request accepted" and "removed" leave no follow row to derive from.

- `notifications(id, user_id, actor_id, kind, created_at, read_at)`, `kind in ('new_follower', 'follow_request', 'request_accepted')`, unique `(user_id, actor_id, kind)`. A repeat (follow → unfollow → follow) refreshes the one row instead of adding rows.
- Written only inside `follow` / `accept_follower`. `unfollow`, `decline_follower`, `remove_follower` and `block` delete the matching unread rows, so the badge never points at something gone.
- The Friends nav item shows `notification_count()`. It's fetched on load, on window focus and every 60 s while visible; no Realtime subscription for this run. Opening `/friends` marks them read.

## Decision 7 — Activity events

`activity_events(id, user_id, kind, dedupe_key, payload jsonb, created_at, updated_at)`, unique `(user_id, dedupe_key)`. No client grants at all; written only by triggers. Owners don't read their own table rows either: everything goes through `get_feed`.

| Kind | Generated by | Burst / idempotence rule | Feed text |
|---|---|---|---|
| `lines` | `after insert` trigger on `quiz_attempts`, when the row is correct and it's the player's **first** correct answer on that `(course_id, line_id)` | One event per player, course and **session**: a new line within 30 min of the event's `updated_at` increments `payload.count` instead of inserting. `dedupe_key = lines:<course>:<session start>`. Ten lines in one sitting = one event. | "Sam trained 3 new lines in the Italian" |
| `streak` | Same trigger, only on the player's first attempt of a UTC day; computes the streak once per day | Milestones 7, 14, 30, 50, 100, then every 100. `dedupe_key = streak:<n>:<start date>`; a re-insert hits the unique key and does nothing. | "Sam reached a 14-day streak" |
| `rating` | `after update of ratings` trigger on `linked_accounts` (the Insights sync writes it) | One event per platform, time class and ISO week: `payload.from` is set on insert and kept, `payload.to` is updated. Shown when `|to − from| ≥ 20`. A re-sync with unchanged ratings changes nothing. `dedupe_key = rating:<platform>:<class>:<ISO week>` | "Sam's Lichess blitz rating is up 40 this week" |
| `course` | `after insert` trigger on `course_progress` | One per course ever: `dedupe_key = course:<id>` | "Sam started the Caro-Kann" |

- **Imported ratings are unverified** (ADR 0006 asked for a label): rating items and the profile's ratings carry "imported from Lichess", plus "unverified" for every Chess.com link and any unverified Lichess link.
- **Retention:** 90 days. The trigger deletes the player's own events older than that on its first event of the day (cheap with the index). The feed reads 30 days.
- **Unlinking** a platform deletes its `rating` events (trigger on `linked_accounts` delete).
- **Client grouping** (pure, tested): the feed groups consecutive items per friend per day ("Sam · trained 5 lines in the Italian · reached a 14-day streak").
- **Not generated:** follows, blocks, anything about other players, Insights "repeat mistakes", or anything from guests.

## Decision 8 — Abuse limits

A generic `rate_limits(user_id, bucket, window_start, calls)` with an atomic claim, the same shape as `insights_claim_sync` (0007):

| Bucket | Limit | Enforced in |
|---|---|---|
| `follow` | 30 per hour (follow and request; unfollow is free) | `follow()` |
| `search` | 30 per minute | `search_profiles()` |
| `block` | 60 per hour | `block()` |

On a hit the function raises `rate_limited` with a retry-after hint; the UI shows "Slow down: try again in N s".

Other abuse surfaces and their mitigation:

- **Notification spam** by follow/unfollow loops: one row per pair and kind, and the follow limit.
- **Username enumeration** via search: usernames are already public on the board; search needs an account and is rate limited.
- **Impersonation via linked accounts:** anyone can link "MagnusCarlsen". Mitigations: the "unverified" label, the Challenge dialog showing the exact platform username, and Lichess OAuth (Phase 5) as the path to "verified". Chess.com has no OAuth; a profile-token check is possible later and out of scope.

## Decision 9 — Deletion

Every new table has `on delete cascade` from `profiles` **on every user column**:

| Table | Cascading columns |
|---|---|
| `follows` | `follower_id`, `followee_id` |
| `blocks` | `blocker_id`, `blocked_id` |
| `privacy_settings` | `user_id` |
| `activity_events` | `user_id` (events only ever describe their owner) |
| `notifications` | `user_id`, `actor_id` |
| `rate_limits` | `user_id` |

`DELETE /api/account` needs no change. The SQL test deletes one of two connected accounts and checks that no row in any of these tables mentions it, and that the other account's unrelated rows survive.

## Storage, indexes and expected sizes

Assumptions for sizing (the app is small today; these are planning numbers, not measurements): 10,000 accounts, 50 follows each on average, 20% active weekly.

| Table | Expected rows | Indexes (beyond the PK) | Serves |
|---|---|---|---|
| `follows` | ~500 k | `(followee_id, status)` | Followers list, requests, counts, feed fan-in |
| `blocks` | ~1 k | `(blocked_id)` | Block checks both ways |
| `privacy_settings` | ≤ 10 k | — | PK lookup in `can_view` |
| `activity_events` | ~200 k (90 days) | `(user_id, created_at desc)`, unique `(user_id, dedupe_key)` | Feed, idempotent upserts, retention |
| `notifications` | ~50 k | `(user_id) where read_at is null` | Badge |
| `rate_limits` | ≤ 30 k | — | PK `(user_id, bucket)` |
| `profiles` (existing) | 10 k | **new** `(lower(username) text_pattern_ops)` | Prefix search (`like 'abc%'`); the existing unique index doesn't serve `LIKE` under a non-C collation |
| `quiz_attempts` (existing) | grows with play | **new** `(user_id, course_id, line_id) where correct` | "First correct answer on this line" in the trigger; "lines trained" count |

**Feed query shape:** `follows` (PK prefix scan on `follower_id`, ≤ a few hundred rows) → nested loop into `activity_events (user_id, created_at desc)` with a 30-day bound, filtered by `can_view`, top 30 by `created_at`. Phase 1 seeds the local database to the sizes above and records the real `EXPLAIN (ANALYZE, BUFFERS)` output for the feed, profile, search and friends-board queries in this ADR, so these expectations get checked rather than assumed.

**Trigger cost on `quiz_attempts`:** one indexed existence check per correct answer, plus one streak computation per player per day. `train_commit` stays a single transaction.

## Challenge a friend (spec §2.7)

### Verification (2026-10-19)

| Link | Result | How it was checked |
|---|---|---|
| `https://www.chess.com/play/{u}` | **Works.** `302` → `https://www.chess.com/play/online/new?isInvited=1&opponent={u}` | `curl` from this environment |
| `https://lichess.org/?user={u}#friend` | **Still the link Lichess uses** for "Challenge to a game": `modules/user/src/main/ui/UserShow.scala:70` and `UserList.scala:181` in `lichess-org/lila` master. A live request from this environment got `403` (Lichess refuses this network), so the page's behaviour was not observed here. | Source read; live check blocked |
| Fallback profiles `https://lichess.org/@/{u}`, `https://www.chess.com/member/{u}` | Chess.com `200`; Lichess `403` from here, same cause | `curl` |

**Phones: not done, and I can't do it.** The spec asks for a real iPhone and Android phone, each with the app installed and not. That needs the owner:

| | iPhone, app | iPhone, no app | Android, app | Android, no app |
|---|---|---|---|---|
| Lichess link | _owner to record_ | | | |
| Chess.com link | _owner to record_ | | | |

### Behaviour

- Platforms offered = `challenge_targets()`: none → no button; one → a link straight there (`target="_blank" rel="noopener noreferrer"`); two → a dialog "Challenge on Chess.com or Lichess?" with both usernames and ratings.
- URLs are built in one pure function from the **friend's stored username** only, with `encodeURIComponent`. It's unit-tested, and e2e tests assert the `href`s without opening them.
- If a link stops working, the dialog falls back to the profile URL and says "Opens their profile; challenge from there."
- **Phase 5 (Lichess OAuth, direct challenges) is not part of this plan.** It needs its own approval, an encrypted token store, and a Settings revoke button.

## UI (constraints only)

- **Nav:** "Friends" between Insights and Leaderboard, with the badge (an `aria-label` that includes the count, e.g. "Friends, 2 new"). Hidden for guests and on deployments without Supabase.
- **`/u/[username]`:** header, sections, the single "Some of this profile is private" line, a menu with Block / Remove follower. The owner sees a "View as: everyone / a follower / a friend" segmented control. Courses link to `courseHref()` ("Learn this too").
- **`/friends`:** tabs Following / Followers / Requests (only while approval is on or requests exist) / Search, the feed, and Compare.
- **Leaderboard:** a third tab "Friends" next to All time / This week, for signed-in users. Follow buttons on rows.
- **Settings → Privacy:** four selects, the approve toggle, the blocked list, and the "always public" line.
- Everything that exists is kept: AA contrast in both themes, `prefers-reduced-motion`, keyboard paths with visible focus, real tables with collapse to cards below `sm`, no horizontal scroll at 360 px. Guests keep every existing feature; social UI asks them to sign in.

## Tests

- **SQL** (`scripts/supabase/test-0008.sh`, local only): 0001–0008 applied, 0008 applied twice (idempotence), then:
  - the 96-case visibility matrix through `get_profile`, plus `get_feed`, `search_profiles`, `friends_leaderboard`, `challenge_targets` and `compare_with`, for **owner, follower, friend, stranger, blocked (both directions), pending follower and anonymous**;
  - direct table access denied: `select` on others' rows, any `insert` / `update` / `delete` / `truncate` on the new tables from `anon` and `authenticated`, and `audience` / `can_view` not executable;
  - follow / request / accept / decline / remove / block / unblock state transitions and the refused cases;
  - activity idempotence (the same attempts or the same sync twice gives the same rows) and burst collapse (10 lines → 1 event);
  - rate limits;
  - deletion cascades both ways.
- **Vitest:** the visibility mirror against the shared matrix, feed grouping and text, compare stats, challenge platform selection and URL building.
- **Playwright:** two signed-in test users for every flow in "Done when", axe AA in light and dark on `/friends`, `/u/[username]`, the leaderboard's Friends tab and Settings → Privacy. Challenge URLs are asserted, never opened.

## Phases

| Phase | Deliverable |
|---|---|
| 0 | This ADR. **Stop for approval.** |
| 1 | `0008_friends.sql`, `audience` / `can_view`, read functions, write RPCs, triggers, the SQL test suite and recorded query plans. |
| 2 | Privacy settings UI, follow / request / accept / block / remove, `/u/[username]` with "view as". |
| 3 | Search, `/friends`, the feed, the badge. |
| 4 | Compare, the friends leaderboard, the Challenge button, e2e and axe. |
| 5 | Optional, ask first: Lichess OAuth and direct challenges. |

## Open decisions (owner)

1. **Defaults:** A (all Only me + a preset card on first follow; recommended), B (Friends for learning, stats and activity) or C (A for existing, B for new).
2. **Follow model:** one-way with optional approval, approval off by default. Confirm.
3. **"Openings they play"** under the `linked` section (recommended) or a fifth section.
4. **`linked_accounts.visibility`:** drop it in 0008 (recommended) or keep it as a per-platform switch under `linked`.
5. **Stat names:** "Lines trained" and "Graded moves this week" instead of the spec's "lines learned" and "reviews done", because the server can't see `learnedAt` or tell reviews apart. The alternative is a migration that sends `learnedAt` to the server; it's more work, and the value is still client-reported.
6. **Migration number:** `0008_friends.sql`, since 0007 is taken.

## Consequences

- No new dependencies and no new environment variables.
- All cross-user access goes through about ten `SECURITY DEFINER` functions, and the 96-case matrix tests them against the same truth table as the UI.
- **Known limits:**
  - The global board still shows blocked players to each other (the spec keeps it public).
  - App rating and accuracy stay public whatever the settings say.
  - `course_progress.mastery` is client-reported. Friends see whatever the owner's browser sent; it can only misrepresent the owner.
  - Linked accounts are unverified until Phase 5 (Lichess only).
- **Remote step (later, with permission):** the owner applies `0008_friends.sql` to the hosted project. Nothing touches it before then.
