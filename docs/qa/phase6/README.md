# Phase 6 — polish, performance, accessibility, stretch

Measured on 2026-10-19 in headless Chromium on this VM (4 vCPU, no CPU throttling). The raw numbers are in `perf.json` and `a11y.json`.

## Performance budgets (§3)

Measured on a production build (`E2E_PROD=1 npx playwright test e2e/perf.spec.ts`), with tracing off, because Playwright's DOM snapshots were the main source of jank in the first runs. Dev-mode React costs several times more, so the spec skips itself under `next dev`.

| Budget | Measured | Result |
|---|---|---|
| Dataset gzipped ≤ 700 KB | 401,570 B (2,277,404 B raw) | ✅ |
| Dataset parse ≤ 150 ms (JSON + decode, after download) | median **18.9 ms**, p90 127 ms (9 loads) | ✅ (no worker needed) |
| User move → feedback ≤ 50 ms (mark at the move, measured after the next frame) | median **25.1 ms**, p90 51.3 ms, max 51.6 ms (16 moves, Learn + Recall) | ✅ median; p90/max at the line |
| Catalog renders its cards without jank | 113 cards (every hub for one side, all sections open); scrolling: 0 long tasks, 0 of 51 frames > 50 ms, p95 33 ms | ✅ |

**Notes**
- **Catalog: 113 cards, not 150.** 113 is the most the catalog shows at once (all hubs for one side, with "Facing…" and "Offbeat" expanded), so 150 can't be reached on this dataset.
- **Variance:** this VM faults pages slowly, so parse and move timings are bimodal (for parse, ~10 ms vs ~120 ms). The budgets are checked on the median, and p90 and max are reported alongside.
- **What fixed it:**
  - `content-visibility: auto` on the catalog cards (on a padded wrapper, so focus rings and badges aren't clipped).
  - No viewport prefetch on the 113 card links.
  - Memoised coach-feed messages: lucide icons are `forwardRef`, and every move re-rendered the whole feed.
  - Board config re-applied only when its inputs change by value.

## Accessibility

- **axe** (`e2e/a11y.spec.ts`, WCAG 2.0/2.1 A + AA rules): **0 violations of any impact**.
  - Coverage: 19 pages and states × light and dark: dashboard, catalog, hub, course (chapters, tree, explorer), trainer (learn, mistake, shortcut sheet), review, explore, the opening map and its list, settings (3 tabs), leaderboard, changes, sign in.
- **Fixed on the way:**
  - Contrast of the draw segment in the W/D/L bar (2.2:1 → 7.8:1).
  - Gold and danger text on light surfaces: new `--gold-ink` and `--danger-ink` text tokens.
  - Dark `--muted` on accent-soft (4.45:1 → 5.0:1).
  - The catalog card link's accessible name now comes from its visible text (label-content-name-mismatch).
- **Reduced motion:** the Settings choice (System / Reduce / Full) is mirrored on `<html data-motion>`. It now governs:
  - CSS animations and transitions;
  - board animations everywhere, not only the trainer;
  - the mini-board hover replay;
  - the feed's smooth scrolling.
  Before, only the trainer honoured the Settings override. Covered by `e2e/phase6.spec.ts`.
- **Promotion picker:** a modal dialog with focus on the queen. Q/R/B/N pick directly, arrow keys or Tab cycle through the four pieces, and Esc cancels and puts the pawn back. Focus returns to where it was.

## Stretch (in order)

1. **Opening map**: shipped, at `/openings/map`, linked from the catalog.
   - An icicle of named theory, 8 plies deep. Width = share of master games at the parent position; colour = ECO volume of the deepest name on the path.
   - Click zooms (the URL keeps `?at=`); double-click opens the hub.
   - The List view is the accessible version: an expandable tree with "Zoom map here" and "Open <hub>" actions.
2. **Engine (Stockfish)**: not added. It's GPL-3.0 and needs the owner's go-ahead (see the report).
3. **Authored "What happens next" plans**: shipped.
   - `[%plan]` text plus `[%cal]` arrows on a line's last move are shown on the "Line complete" card and the board.
   - Four plans authored: Najdorf 6.Bg5 main line, Caro-Kann Classical 6.h4, QGD Exchange with Nge2, Italian Canal Variation.
   - Across the 9,689 derived lines they appear on 33 end cards.

## Screenshots

- `opening-map.png`, `opening-map-sicilian.png`: the map at the start and zoomed to 1.e4 c5.
- `authored-plan.png`: the Canal plan on the end card, with its arrows.
- `promotion-picker.png`: the picker after a7xb8.
- `catalog-focus.png`: a keyboard-focused catalog card (ring not clipped).
