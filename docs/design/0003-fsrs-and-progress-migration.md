# ADR 0003 — FSRS scheduling and progress migration

- **Status:** accepted (Phase 0). Implemented in Phase 5.
- **Spec:** §4.3 (card key), §4.9.

## Context

- v1 schedules SM-2 per `(openingId, epd)`. The scheduler is written twice: `src/lib/srs.ts` and plpgsql `answer_challenge`.
- The row-index key is broken (defect 1).
- SM-2 with a single interval multiplier has no retention target. Users of competitors complain about review overload.

## Decision

### Card model

- **Key:** `(side, epd, answerSan)`. `answerSan` is normalised (no `+#`).
  - "As `side` in `epd` I play `answerSan`."
  - Shared across all courses, so a shared trunk is reviewed once.
  - One EPD may hold several cards with different answers (different courses or overrides).
- **State:** the ts-fsrs `Card` fields, re-verified against the installed 5.x types in Phase 5 (`learning_steps` is included; `elapsed_days` is deprecated in 5.x but still serialised), plus `seen`, `correct`, `migratedFrom?`, `archived?`, `deferredFrom?`.
- **Per-course progress** lives separately (`cot.v2.courseProgress[courseId]`): `lastLineId`, `lastStudiedAt`, `tier`, per-line `{learnedAt, lastReviewedAt}`.
  - The daily new-line cap counts lines whose `learnedAt` is today.
  - "Another enrolled course" (ADR 0005 ladder step 2) = any course with a `courseProgress` entry.
- **Extension cards.** The card's `answerSan` is the line's own `ext` move. When the learner plays a different accepted top-3 move, the card is graded on that outcome; no card is created for the alternative.
- **Course card set** = `{(side, epd, bookMove)}` over the course tree's learner-to-move nodes (Complete tier). A tier's set restricts to the tier's lines.
- **Mastery %** = mature cards (`stability ≥ 21` days) ÷ the card set.
- **Archival.**
  - When a data change removes every course containing `(epd, answer)`, the card is flagged `archived`: excluded from queues, never deleted, restored automatically when it reappears.
  - When a course's book move at an EPD changes, the old card stays and the new pair starts fresh. The coach notes "Book move updated here".

### Library

- `ts-fsrs` 5.4.2 (MIT; verified on npm 2026-10-18, stable line; 6.x is beta). One TS module `src/lib/srs/fsrs.ts` wraps it and is shared by guest code and the server route handler (ADR 0004).
- **Parameters:** `request_retention` from settings (default 0.90), `enable_fuzz: true`, `enable_short_term: true`, everything else ts-fsrs defaults.

### Auto-grading

| Outcome | Rating |
|---|---|
| Correct, no hint, answered < 2.5 s, and card `reps ≥ 2` | Easy |
| Correct, no hint | Good |
| Correct after H1 (idea) or H2 (piece) | Hard |
| Correct after H3 (show), or any wrong move that is not a soft-fail | Again |
| Soft-fail (another theory move, or the learner's book move from another course) | no grade; the learner must still play the book move |
| Extension ply (`ext`) answered with any accepted top-3 move | the same rules |

- A position is graded **once per presentation**: the first final outcome, with the hint level reached.
- Recall (straight after Learn) is the first real rep. Learn itself only *introduces* cards: state New → first scheduled by Recall.

### Workload control

- **Daily new-line cap** (default 5): counts lines whose first Learn is today.
- **Daily review cap** (default 150).
  - When more cards are due than the cap, sort the due cards by current retrievability R (ascending; ts-fsrs `get_retrievability`).
  - Today's queue is the first `cap` cards.
  - The overflow is **explicitly deferred**: its `due` is moved to the start of tomorrow, then the next day, in R order, keeping each day ≤ cap.
  - Cards are never dropped. Deferral is written to the card state (an audit field, `deferredFrom`).
- **Forecast:** simulate the next 7 days. For each card, count it on its due day (overdue → today); the simulation assumes each review is answered Good and re-schedules with ts-fsrs. Shown on the dashboard and in the tier chooser ("Core adds ~11 reviews/day next week", computed by adding the tier's new cards at the daily new-line cap).

### Guest migration (`cot.v1.*` → `cot.v2.*`)

- Runs once on load. It is idempotent: the marker `cot.v2.migrated` holds the source hash.
- The backup `cot.v1.backup` is written **before** any v2 key.
- **Cards.** Each v1 card `(openingId, epd, ease, intervalDays, reps, lapses, due)` is mapped through `legacy-map.v1.json` (`openingId → finalEpd/bestCourseId`):
  - `side` = the side to move at `epd`.
  - `answer` = the move the v1 row actually played at `epd`, recovered from the legacy map's `sans` (the v1 card was learned on that row's family, and `lineSans` gives the prefix). Else the book move of `bestCourseId`'s tree at `epd`. Else the most-played theory move. Else drop the card and log it in `cot.v2.migrationReport`.
  - **FSRS state:**
    - `stability = max(0.5, intervalDays)`
    - `difficulty = clamp(5 + (2.5 − ease) × (4 / 1.2), 1, 10)`, so ease 2.5 → 5 and ease 1.3 → 9
    - `due`, `reps` and `lapses` are kept
    - `state = reps > 0 ? Review : New`
    - `last_review = due − intervalDays`
    - `migratedFrom = "sm2"`
  - **Merge** when several v1 cards map to one v2 key: keep the state with the most reps (ties → earliest `due`), and sum `lapses`, `seen` and `correct`.
- **Opening progress.** `cot.v1.openingProgress` maps to `cot.v2.courseProgress` keyed by `bestCourseId`: seen/correct/streak summed, `updatedAt` = max.
- `cot.v1.attempts` and `cot.v1.profile` are copied as-is (rating stays). `cot.v1.prefs` → `cot.v2.prefs`, with the new fields defaulted.
- **`clearLocalData()`** clears `cot.v2.*` only. Removing `cot.v1.backup` needs a second explicit confirmation in Settings.

## Consequences

- One scheduler implementation. The plpgsql SM-2 is retired with the server move (ADR 0004).
- Review load is bounded by the user's caps, and the deferral is visible in the forecast.
- Migrated cards keep their intervals approximately. FSRS recalibrates them after the first review.
