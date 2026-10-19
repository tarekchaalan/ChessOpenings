# Claude Code Prompt — Friends (follow, profiles, shared progress)

## 0. Your mission

Let players follow each other and see what their friends are learning:
the openings they're studying, their training stats, and their Elo from linked
Chess.com and Lichess accounts. Each player controls exactly what others can
see.

This builds on **Account Insights** (`docs/prompts/account-insights.md`). If
its tables (`linked_accounts`, `game_summaries`) aren't in the codebase yet,
stop and tell me: ratings, played openings and the usernames the Challenge
button uses come from there.

## 1. Ground rules

- Read the codebase first: `profiles`, `course_progress`, `srs_cards`, the
  leaderboard views and the RLS policies in `supabase/migrations/`;
  `src/lib/supabase/`, `src/app/api/`, `src/components/leaderboard/`,
  `src/components/settings/`; and the Insights tables and ADR
  (`docs/design/0006-account-insights.md`).
- Write an ADR (`docs/design/0007-friends.md`) before any code. It must
  settle the follow model, visibility rules, what each audience sees, blocking,
  how cross-user reads are secured, and what deletion removes. Stop and show
  it to me.
- **Privacy by default.** Nothing becomes visible to others that wasn't
  visible before without the player choosing it. Never expose an email
  address. Linked-account usernames and ratings follow the player's own
  visibility setting.
- **Cross-user reads go through the database, not the client.** Use
  SECURITY DEFINER functions or views that apply visibility and blocks,
  with RLS on every table. Tests must prove a non-follower, a blocked user
  and an anonymous visitor can't read what they shouldn't.
- Tests first for the pure logic (visibility resolution, feed building,
  comparison stats), and SQL tests for the policies and functions.
- Supabase: write and test migration `0007_...sql` locally, but **ask before
  anything touches the hosted project**. Never run `supabase config push`;
  it applies immediately and resets every omitted `[auth]` setting.
- Keep everything that exists: WCAG AA in both themes, reduced motion,
  keyboard navigation, phone width without horizontal scroll. Guests keep
  working, and only accounts can follow or be followed.

## 2. Product design

### 2.1 Follow model
- **Default proposal (confirm in the ADR):** one-way follow, like Lichess or
  Twitter. "Friends" means people who follow each other.
- An optional **approve followers** setting: follows become requests the
  player accepts or declines.
- **Block:** removes any follow in either direction, hides each player from
  the other everywhere (profiles, search, feed, the friends leaderboard),
  and prevents new follows. The blocked player isn't told.
- **Remove follower:** without blocking.

### 2.2 Visibility (Settings → Privacy)
Per section, each set to **Everyone / Followers / Friends (mutual) / Only
me**:
- Ratings (from linked accounts) and linked usernames
- Openings I'm learning (courses in progress and mastery)
- Training stats (streak, lines learned, reviews done, accuracy)
- Activity in the feed

The username and the existing global leaderboard entry stay public, as
today. Propose defaults in the ADR; I'll decide.

### 2.3 Profile page (`/u/[username]`)
- Header: username, follow button (or "Requested" / "Following"),
  follower and following counts, and a "Friends" badge when mutual.
- Sections, each shown only when the viewer may see it:
  - **Ratings:** per platform and time class.
  - **Learning now:** courses with progress and mastery. Each links to the
    same course in the catalog ("Learn this too").
  - **Stats:** streak, lines learned, reviews this week, accuracy.
  - **Openings they play:** from Insights, top openings by color with
    results.
- A hidden section shows nothing, not an empty box or a "private" label
  per field. One line "Some of this profile is private" is fine.
- Menu: block, remove follower.
- Your own profile shows a "view as: everyone / a follower" preview.

### 2.4 Finding people
- Search by username (prefix, case-insensitive, rate limited) on a
  `/friends` page, plus follow buttons on the leaderboard and profiles.
- A shareable profile link.
- No contact import, and no suggestions from anything outside this app.

### 2.5 Friends page (`/friends`)
- Tabs: Following, Followers, Requests (when approval is on), Search.
- **Feed:** what friends did recently, grouped so it doesn't spam. Examples:
  "Sam learned 3 new lines in the Italian", "Sam reached a 14-day streak",
  "Sam's Lichess blitz rating is up 40 this week". Only items the viewer
  may see.
- **Compare:** pick a friend to see a side-by-side for openings you both
  learn (mastery, accuracy) and ratings on the same platform.

### 2.6 Leaderboard
Add a "Friends" filter to the existing leaderboard: you plus the people you
follow, using the same scores as the global board.

### 2.7 Challenge a friend
A **Challenge** button on a friend's profile and in the Following list. It
starts a real game on Chess.com or Lichess against that friend's linked
account.

- **Which platforms to offer:** only those where both players have a linked
  username, the friend lets the viewer see that username (2.2), and neither
  has blocked the other. With none, the button is hidden. With one, it goes
  straight there. With two, a small dialog asks "Challenge on Chess.com or
  Lichess?", showing each side's username and rating there.
- **How it opens (baseline, no extra login).** Open in a new tab; on phones
  the platform's app may catch the link instead.
  - Lichess: `https://lichess.org/?user={username}#friend` (what Lichess's
    own "Challenge to a game" button uses). It opens "Play with a friend"
    addressed to them; the player picks a time control and sends.
  - Chess.com: `https://www.chess.com/play/{username}` (documented in
    Chess.com's help center). It opens a challenge to that member.
- **Lichess direct (optional, after the baseline works).** If the player
  has connected Lichess with OAuth (PKCE, `challenge:write` scope), send the
  challenge from the dialog with `POST /api/challenge/{username}`: time
  control, rated or casual, color. Then open the game or the challenge page.
  Real-time challenges expire after 20 s unless accepted, so use
  `keepAliveStream` or explain the expiry. Never store the token in
  localStorage; keep it server-side, encrypted, revocable from Settings.
- Chess.com has no API for creating challenges, so it always uses the link.
- **Verify before building:** confirm both URLs still behave as described,
  and record on a real iPhone and Android phone (each app installed and not)
  whether the link opens the app or the website. Write the results in the
  ADR. If a URL no longer works, fall back to opening the friend's profile
  on that platform and say so in the dialog.
- Usernames go into the URL encoded (`encodeURIComponent`); never build it
  from anything but the linked username stored on our side.

### 2.8 Notifications
In-app only for this run: a badge on the Friends nav item for new followers,
follow requests and accepted requests. No email.

## 3. Data and storage

- **Migration `0007`:**
  - `follows`: follower_id, followee_id, status (`active`/`pending`),
    created_at. Primary key on the pair; no self-follow.
  - `blocks`: blocker_id, blocked_id, created_at.
  - `privacy_settings`: user_id plus one visibility enum per section from
    2.2, and `approve_followers`.
  - `activity_events`: user_id, kind, payload jsonb, created_at. Written
    only by SECURITY DEFINER functions or triggers, never by clients.
  - `notifications` (or a view over `follows`): enough for the badge.
- Everything has `on delete cascade` from `profiles`, so the existing
  `/api/account` deletion removes follows, blocks, settings, activity and
  notifications in both directions.
- **One visibility function**, e.g. `can_view(viewer, owner, section)`,
  used by every cross-user read: profile sections, feed, search results and
  the friends leaderboard. Blocks win over everything.
- **Activity events:** generate them from what the app already records
  (course progress, streaks, Insights syncs). Make it idempotent, with no
  duplicates on re-sync. Collapse bursts: 10 lines in one session is one
  event.
- **Abuse limits:** cap follows per hour and search requests per minute,
  enforced server-side.
- Indexes for every query the feed, profiles and search make. Note the
  expected row counts and query plans in the ADR.

## 4. Phases and acceptance criteria

- **Phase 0:** ADR with the follow model, visibility defaults and policy
  design. Stop for my approval.
- **Phase 1:** migration, visibility function, RLS policies and SQL tests:
  owner, follower, mutual friend, stranger, blocked user and anonymous
  visitor against every section.
- **Phase 2:** follow, unfollow, request and accept, block and remove
  (server routes or RPCs), privacy settings UI, and profile pages with the
  "view as" preview.
- **Phase 3:** search, the Friends page, the feed with activity generation,
  and the notification badge.
- **Phase 4:** compare view, the friends leaderboard filter, and the
  Challenge button (link baseline, both platforms). e2e tests for every flow
  with two signed-in test users (assert the challenge URLs; no live calls);
  axe AA in light and dark.
- **Phase 5 (optional, ask first):** Lichess OAuth and direct challenges
  through the API.

**Done when:**
- Two accounts can follow, request, accept, unfollow, block and unblock
  each other.
- Each visibility setting changes what the other account sees, and the SQL
  tests show no section leaking to anyone it shouldn't.
- Blocking hides both players from each other everywhere.
- Challenge offers only platforms both players have linked and the viewer
  may see, and opens the right player on the right site.
- Deleting either account removes every row about it.
- `npm run lint`, `npm run typecheck`, `npm test` and the e2e suite pass.

## 5. Out of scope (design so they plug in later)

Email and push notifications, direct messages or comments, groups and
clubs, in-app races between friends ("who finishes this course first"),
Chess.com challenges by API (none exists), and suggestions from contacts or
other sites.

## 6. Final report

What shipped, test results with real numbers (including the policy test
matrix), the visibility defaults chosen, anything skipped and why,
remaining privacy or abuse risks, and anything I need to do remotely
(migration, environment variables).
