# ADR 0008 — First-login setup and estimated Elo

- **Status:** accepted and built (2026-10-19). Requested by the owner: "account linking as part of signup/onboarding: on the first login after verifying their email, a modal asks for the accounts, and everything that follows is based on that, including an estimated Elo (taking into account new accounts with a starter rating like 1500)."
- **Migration:** `0009_player_setup.sql`, tested locally (`scripts/supabase/test-0009.sh`); the owner applies it to the hosted project.

## Decisions

1. **When the modal shows.** On every page for a signed-in player with no `player_setup` row. The first signed-in page after the email link is `/auth/callback` → `/`, so it appears right after verification. Accounts that existed before this change also see it once (prefilled with any account they linked through Insights). Hidden on `/auth/*`.
   - **Not now** (✕ or Esc): closes for this browser session; nothing is stored, so it asks again next time.
   - **Skip setup**: stored (`skipped = true`); Settings → Account offers "Run setup".
   - **Re-run**: the level card's "Update accounts or level" (dashboard, Settings) reopens it.
2. **Steps.** (1) Lichess / Chess.com usernames, each checked live on the platform (the Insights lookup, browser-side). (2) Only when no linked rating is reliable: "How would you describe your chess?" with five levels. (3) The estimate, what it's based on, which ratings didn't count and why, and what it sets up. **Start training** links the accounts (the Insights link route), stores the answers, applies the level's defaults and imports games for Insights in the background.
3. **Estimated Elo** (`src/lib/rating/estimate.ts`, pure):
   - One number on an Elo-like scale close to FIDE, from piecewise-linear conversion tables per platform. They approximate public surveys (ChessGoals; M. Jensen 2020, ±130–165): Lichess runs about 200–300 above FIDE below ~2400, Chess.com about 200 below FIDE under 2000 and above it from ~2000. **This is approximate**, and the page says so ("likely 1300–1600", with a confidence label).
   - **New accounts:** a rating with fewer than **20 games** doesn't count. That covers Lichess's 1500? start and Chess.com's sign-up levels (400 / 800 / 1200 / 1600 / 2000); the modal names the rating and why it was ignored. A provisional rating with 20+ games (e.g. inactive) counts at a quarter.
   - **Weights:** classical and rapid 1, blitz 0.8, bullet 0.4, times min(1, games / 100). Confidence comes from established non-bullet games: ≥150 high (±150), ≥40 medium (±200), otherwise low (±300). Rounded to tens.
   - **Self-reported level** (when no rating counts): New 600, Basics 900, Casual 1200, Club 1600, Strong 2000, low confidence. A rating that counts always wins over the self-report.
   - **Live:** recomputed from the linked ratings whenever Insights syncs them; the stored copy is updated when it changes.
4. **What the estimate drives** (`src/lib/rating/level.ts`). Five levels with the same names as Insights' bands (edges 0 / 900 / 1300 / 1700 / 2000):

   | | Beginner | Improving | Club | Strong club | Expert+ |
   |---|---|---|---|---|---|
   | Suggested openings (catalog level, own first) | beginner | beginner | beginner, intermediate | intermediate, advanced | advanced, intermediate, beginner |
   | Course depth starts at | Essentials | Essentials | Core | Complete | Complete |
   | New lines a day (only if still the default 5) | 3 | 4 | 5 | 6 | 8 |

   - **Dashboard:** an "Estimated Elo" card, and "Start here" (no cards yet) or "Suggested for your level": the most-played openings at the level, for White and Black.
   - **Catalog:** a "For your level" row for the chosen side (hidden while filtering).
   - **Course page:** the depth selector starts at the level's tier (stored in this browser so it's right on first paint, applied after hydration).
   - **Insights:** recommendations use the platform band from imported games as before; until there are enough games, they use the estimate's level.
5. **The leaderboard rating is not seeded.** `profiles.rating` still starts at 800 and moves only through server-graded answers. Linked usernames are unverified (anyone can type "hikaru"), so seeding would let anyone start at the top of the board. The modal says the two are separate. If seeding is wanted later, the safe version is a capped seed (e.g. at most 1500) or one that needs Lichess OAuth verification first.
6. **Storage.** `player_setup` (own table, not `profiles`, which everyone can read): `completed_at`, `skipped`, `self_level`, `estimated_elo` (100–3500), `estimate` jsonb (≤ 4 KB: confidence, range, source, basis), `updated_at`. Own-row select only; writes only through `save_setup(p jsonb)`, which validates every key and refuses unknown ones; `get_setup()` returns the caller's row or null. Cascades from `profiles`. The estimate is computed client-side and only personalises its owner's pages, so the server checks shapes and ranges, not the arithmetic.

## Tests

- **Unit** (`src/lib/rating/__tests__/estimate.test.ts`, 14): conversion points, monotonicity and survey equivalences; new accounts at starter ratings ignored; time-class and games weighting; provisional quarter weight and confidence; both platforms; self-level fallback; rounding and range; the stored record; levels; real starter courses from the dataset.
- **SQL** (`scripts/supabase/test-0009.sh`): null before setup; complete / skip / update keep `completed_at`; every validation; `profiles.rating` untouched; own row only; no client insert / update / delete / truncate; anonymous denied; deletion cascade. All passed.
- **e2e** (`e2e/onboarding.spec.ts`, 5, against the Supabase stand-in with Lichess / Chess.com mocked from fixtures; the `/api/insights` routes are answered in the test with the row the route would write, since the e2e build has no server keys):
  - established accounts → estimate → stored row, linked accounts, leaderboard rating 800 → dashboard card and "Start here" → no modal on reload → catalog row → course depth Complete → Settings re-run;
  - a brand-new account (1500? after 3 games) → ignored with the reason → level question → ≈1200 Improving → Essentials depth and 4 new lines a day;
  - Esc lasts the session, skip is stored, setup re-runs from Settings without an account;
  - axe AA in light and dark on every step, and 360 px width.

## Not covered

- The real email-confirmation round trip isn't in e2e (the stand-in has no email). The modal keys on "signed in without a setup row", which is the state right after the callback.
- The conversion tables are approximations, as above. Tune them in `TO_ELO`; every consumer goes through `estimateElo()`.
