# 0000 — Phase 0 inventory (v1 call sites)

Snapshot of the v1 code that the v2 work replaces, taken on branch `feat/trainer-v2` at the start of Phase 0. Line numbers are from commit `7cb04bd`.

## Row-index identity (`openingId`) — defect 1

| Layer | Sites |
|---|---|
| Types | `lib/srs.ts:14,28,30` (`SrsCard.openingId`, `cardKey`), `lib/progress/types.ts:4,15`, `lib/quiz/types.ts:38,44` |
| Guest engine | `lib/quiz/local.ts` (`issue`, `issueReview`, `walk`, `answer`, `masteryPct`) |
| Guest storage | `lib/progress/local.ts:61,88-110` → `cot.v1.cards` (key `openingId|epd`), `cot.v1.openingProgress` (keyed by `openingId`) |
| Remote | `lib/quiz/remote.ts:38,50` (`p_opening_id`), `lib/progress/remote.ts:17-70`, `app/api/progress/route.ts:34` |
| SQL | `0001_schema.sql`: FKs on `srs_cards`, `quiz_challenges`, `opening_progress` → `theory_openings.id`; `quiz_attempts.opening_id` has no FK; `issue_challenge`, `issue_review_challenge`, `answer_challenge`, `compute_mastery`, `family_next_moves(p_root)`. `0003`: 5-arg `issue_challenge`. |
| URLs | `/learn/{id}`: Explorer:230, LearnCatalog:50,62, Dashboard:159,246. `/quiz/{id}`: Explorer:236, LearnClient:263, QuizHome:79,89,106, QuizSession:328, Dashboard:153,253 |

## Family / playlist helpers (defects 2 and 3)

- `familyOf` → LearnClient, QuizStart, QuizSession, quiz/local.
- `familyNextMoves` → LearnClient, mainline.ts, quiz/local.
- `openingCatalog` → QuizHome (`.slice(0,12)`), LearnCatalog (`.slice(0,30)`), Dashboard (`.slice(0,3)`).
- `defaultSide` (regex heuristic) → QuizHome, QuizStart, LearnCatalog, LearnClient.
- `trainablePlies` (dead), `updateLocalMastery` (dead).
- `buildPlaylist`, `startPlyFor` (QuizSession); `greedyMainline` (LearnClient); `coreLines`/`masteryPct` (quiz/local only).
- `searchOpenings` → OpeningSearch (limit 12). `nameForLine` → Explorer, QuizSession, LearnClient.

## Coach

- `ANNOTATIONS` (74 entries, keyed by space-joined SAN prefix) imported only by `lib/explain.ts:12,27`.
- `explainMove` → LearnClient:92. `openingBlurb` → LearnCatalog:72, LearnClient:288. `createsPin` always returns `false`.

## SRS (`lib/srs.ts`, SM-2, mirrored in plpgsql `answer_challenge`)

Importers: quiz/local (`answerQuality`, `cardKey`, `isMature`, `newCard`, `reviewCard`), progress/local (`SrsCard`, `cardKey`, `dueCards`), progress/remote, progress/types, ReviewSession (`dueCards`), QuizSession (type).

## localStorage

`cot.v1.cards`, `cot.v1.attempts` (cap 500), `cot.v1.profile`, `cot.v1.openingProgress`, `cot.v1.prefs`. `clearLocalData()` (`lib/prefs.ts:54`) removes every `cot.v1.*` key; called from SettingsClient:360. next-themes uses `theme`. Supabase sessions live in cookies.

## Routes

`/` Dashboard · `/explore` Explorer (`?line=`) · `/learn` LearnCatalog · `/learn/[id]` LearnClient · `/quiz` QuizHome · `/quiz/[id]` QuizStart→QuizSession · `/quiz/review` ReviewSession→QuizSession · `/leaderboard` · `/settings` · `/auth` · `GET /auth/callback` · `GET /api/progress` (`withSupabase`). `src/proxy.ts` refreshes auth cookies.

RPCs: `issue_challenge`, `issue_review_challenge`, `answer_challenge`, `daily_streak`. Tables read: `profiles`, `opening_progress`, `quiz_attempts`, `srs_cards`, `leaderboard_global`, `leaderboard_weekly`. `seed-remote.ts` writes `theory_openings`/`theory_edges` with the service role.

## Keyboard

- Explorer (window): ←/→ scrub/advance, ↑/↓ select candidate, Enter play, F flip, Home/Backspace reset.
- Learn (window): →/Space/Enter advance, ← back, H hints.
- OpeningSearch (input): ↑/↓, Enter, Esc.
- Quiz/Review/Board: none.

## Environment notes (verified 2026-10-18)

- `.claude/agents/` does not exist in this checkout (`.claude` is gitignored), so the `scout` / `designer` / `engineer` / `builder` / `reviewer` / `mechanic` roles are played by general-purpose sub-agents with the same briefs.
- No `zstd` CLI and no apt access to install it. Node's `zlib` zstd stops after the first frame of the multi-frame lichess dumps. The corpus step uses the `zstd` CLI when present, else `fzstd` (MIT, pure JS).
- Docker CLI and `psql` exist, but the Docker daemon is not running.
