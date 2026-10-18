# ADR 0002 — Hubs, systems, chapters, lines, tiers

- **Status:** accepted (Phase 0). Thresholds are tunables in `src/lib/openings-build/tunables.ts`; Phase 2 records the measured outcome here.
- **Spec:** §3.1, §4.4, §4.5, §4.6 (reach), §4.7 (extension).

## Context

- v1 groups openings by the text before the colon and roots each family at its *shortest* row.
- That loses every transposed or sibling line (533/3,733 rows unreachable), heads the catalog with 1-ply "openings", and splits real openings (London) across name groups.

## Decision

### Vocabulary

| Term | Meaning |
|---|---|
| **G** | Global theory graph: EPD nodes, edges = moves on any TSV row. |
| **Hub** | A set of rows `R_h` selected by a name query: curated (`src/content/hubs.ts`) or auto (one per unclaimed family). |
| **C** | The canonical row: the shortest row whose full name equals the hub's primary name (ties → most master games), else the shortest row in `R_h`. A curated hub may set `signature` moves explicitly. |
| **Defining side** | Curated `side`, else keywords tested on the hub's **primary name** (C's full name for auto hubs), with this precedence: "Accepted"/"Declined" → the opponent of the gambit's side (the gambit's side is found by applying the rules below to the name with that word removed); then Defense/Defence/Countergambit → Black; then Gambit/Attack/Opening/Game/System → the side that made C's last untrimmed move; else C's last mover. Computed before σ. Courses for the other side reuse the same σ, approach, sibling and early-deviation split; only the learner/opponent roles swap. |
| **σ** | C's final position, trimmed back until its last move belongs to the defining side. |
| **Approach** | C's path from the start to σ. Learner approach moves are cards and fast-forward once known. |

### Hub membership and coverage

1. Compute the forward closure `F(σ)`: every position reachable from σ along edges of G.
2. A row of `R_h` is **covered** if its path contains σ or any position of `F(σ)` (transposition attachment). The attachment point is the first such position. Earlier moves become a move-order note.
3. Uncovered rows are classified by the first divergence from C's path:
   - **Divergence by the defining side before σ.** Group by the diverging move. Groups with ≥ `SIBLING_MIN_ROWS` (3) rows become **auto sibling hubs**, built recursively with the same rules and named by the deepest common name. Smaller groups go to **Offbeat**. The parent hub lists its siblings.
   - **Divergence by the opponent before σ.** The row joins the **Early deviations** chapter, rooted at the divergence point.
   - **Anything else** → `unassigned` with a reason.
4. The build prints a per-hub coverage table. A curated hub below 95% (counting siblings and early deviations) is a warning.

### Hub DAG

The union of:
- the paths of covered rows from their attachment point;
- C's approach path;
- early-deviation paths from their divergence point;
- for every attachment point `a` not reachable from σ through hub-row edges, a **connecting path** in G from σ to `a`. At learner nodes it is chosen by the book-move rule; at opponent nodes, by most games, then by fewest plies. It is found by BFS over G restricted to `F(σ)`.

Edges carry the row names they realise. Without connecting paths, transposition-attached rows would count as covered but be unreachable in every course tree.

### Systems (§4.5)

- **Search.** Walk from σ:
  - at **opponent** nodes, follow the most-played hub move (the main path);
  - at **learner** nodes within the first `SYSTEM_MAX_LEARNER_DEPTH` (4) learner moves after σ, branch on every learner move whose hub-DAG subtree holds ≥ `SYSTEM_MIN_LINES` (3) **leaves** (positions with no further hub-DAG move; this is a proxy for lines, because lines are enumerated later) or ≥ `SYSTEM_MIN_SHARE` (10%) of the hub's rows.
  - Stop a path early when its opening name stops being a descendant of the hub's names.
- **Definition.** Each leaf of that choice tree is a system: a map `EPD → SAN` of defining choices.
  - Name: the deepest name common to ≥ `SYSTEM_NAME_SHARE` (80%) of the subtree's rows, de-duplicated within the hub by appending the defining move.
  - Slug: from the name.
  - Signature: the position after the last defining move.
- **Display.** Ordered by reach. The first `SYSTEM_MAX_SHOWN` (8) are shown; the rest go behind "More systems". **Recommended** = the most master games.
- **Variant systems (coverage remedy) — DEVIATION from the spec, needs sign-off.** The spec has only depth-4 systems. The depth-4 rule alone leaves some rows unreachable from both sides' courses: rows where both colours leave the book after the choice zone, e.g. Najdorf 6.Bg5 e6 7.f4 Qb6. After the base systems are built, run greedy set cover over still-uncovered rows:
  - Pick the learner node and alternative move (inside some course's tree) whose subtree covers the most uncovered rows.
  - Create a variant system = parent system + that choice ("Najdorf · Poisoned Pawn (7…Qb6)").
  - Repeat until no candidate covers anything (cap `VARIANT_MAX_PER_SYSTEM`).
  - Variants are listed under their parent and share cards with it (cards key on positions).
  - Greedy order depends on the data, so a variant's slug is derived from its parent slug plus the alternative's SAN path (e.g. `najdorf~7-qb6`), not from its rank. That keeps it stable when other variants come or go.

### Course tree

A course tree is rooted at the start position:

- **Approach:** C's path. Opponent moves before σ branch only where hub rows deviate (early deviations).
- **Learner nodes:** exactly one move, chosen in this priority order:
  1. user override (per course, `EPD → SAN`)
  2. system choice
  3. book-move rule: most master games → most descendant lines → first in data order

  The other theory moves at that node are recorded as `alternatives`.
- **Opponent nodes:** every hub-DAG move.
- **Overrides** are blocked at system-defining EPDs ("Switch system" instead). A course with overrides is re-derived on the client by the same pure function, memoised by `(courseId, overridesHash, outputHash)`.

### Extension (§4.7)

- Before enumerating lines, extend each leaf from position stats:
  - **Learner:** the most-played move.
  - **Opponent:** up to `EXT_MAX_BRANCHES` (2) replies with share ≥ `EXT_MIN_SHARE` (25%) and ≥ `EXT_MIN_GAMES` (8) games.
- Limits: at most `EXT_MAX_PLIES` (8) extra plies; never past `maxPly`; stop at positions with < 8 games.
- Extension plies are flagged `ext`. They are dashed in the UI and graded softly: any of the top 3 moves with ≥ 15% share is accepted.

### Lines

- Enumerate root-to-leaf paths in descending reach.
  - When a path enters a position that an earlier line reached through a **different incoming edge** (a transposition), the new line ends there with `transposesTo`. Positions shared through the same trunk are not transpositions.
  - Lines with < 2 learner moves after σ, even after extension, fold into their parent as notes.
- **Reach** = the product over **every opponent-to-move node on the path from the root** (approach and early-deviation nodes included) of `(games(move) + 1) / Σ(games + 1)` over the course tree's kept replies at that node. Learner nodes contribute 1. Nodes with a single kept reply contribute 1, so the plain approach is neutral. The line masses therefore sum to 1, minus the mass of folded lines; tier coverage is reported against that total. The UI's "of master games from σ" figures renormalise over lines through σ. Labelled "of master games" (not rating-banded).
- **Names:**
  - Line: the deepest name segments not already in the chapter or system name, plus "(key move)" for the move after the last branch point. Fallback: "6…e5 line". Must be unique within the course; collisions get the next distinguishing move appended.
  - Chapter: at the first opponent branch after σ (and for each early-deviation divergence), each reply with ≥ `CHAPTER_MIN_LINES` (3) lines or ≥ `CHAPTER_MIN_REACH` (5%) reach becomes "Shared name (move)". The rest group into "Other Nth moves (a, b…)". Chapters with ≥ `SECTION_MIN_LINES` (12) lines split once more into sections at their next opponent branch.

### Tiers

| Tier | Rule |
|---|---|
| **Essentials** | The smallest prefix of lines (by reach) reaching ≥ 80% reach mass, at least min(5, all) and at most 20 lines |
| **Core** | ≥ 95% mass, at most 60 lines |
| **Complete** | Every line |

Identical tiers collapse in the UI. Coverage % = the tier's reach mass.

### Catalog placement

- A hub is **top-level** if, after building, its best course for the default side has ≥ 3 lines and max depth ≥ 8 plies (spec §3.1; this applies to curated hubs too). Otherwise it goes to **Offbeat & surprise weapons**.
- A non-curated hub whose σ is shorter than `MIN_SIGMA_PLIES` (2) plies is always Offbeat.

### Tunables

| Name | Default | Used by |
|---|---|---|
| `SYSTEM_MAX_LEARNER_DEPTH` | 4 | system search |
| `SYSTEM_MIN_LINES` | 3 | system search |
| `SYSTEM_MIN_SHARE` | 0.10 | system search |
| `SYSTEM_NAME_SHARE` | 0.80 | system naming |
| `SYSTEM_MAX_SHOWN` | 8 | hub page |
| `VARIANT_MAX_PER_SYSTEM` / `VARIANT_MAX_TOTAL` | 30 / 400 | coverage remedy |
| `RECOMMENDED_MIN_LINES` | 3 | recommended system |
| `SIBLING_MIN_ROWS` | 3 | sibling hubs |
| `CHAPTER_MIN_LINES` | 3 | chapters |
| `CHAPTER_MIN_REACH` | 0.05 | chapters |
| `SECTION_MIN_LINES` | 12 | sections |
| `ESSENTIALS_MASS` / `MIN` / `MAX` | 0.80 / 5 / 20 | tiers |
| `CORE_MASS` / `MAX` | 0.95 / 60 | tiers |
| `TOP_LEVEL_MIN_LINES` / `MIN_DEPTH` | 3 / 8 | catalog |
| `EXT_MAX_PLIES` | 8 | extension |
| `EXT_MIN_GAMES` | 8 | extension |
| `EXT_MIN_SHARE` | 0.25 | extension |
| `EXT_MAX_BRANCHES` | 2 | extension |
| `EXT_GRADE_TOP` / `EXT_GRADE_SHARE` | 3 / 0.15 | soft grading |
| `MIN_LEARNER_MOVES_AFTER_SIGMA` | 2 | line folding |
| `MIN_SIGMA_PLIES` | 2 | catalog |
| `HUB_COVERAGE_WARN` | 0.95 | build warning |
| `EXT_STOP_GAMES` | 8 | extension stop (position games) |
| `STATS_MIN_GAMES` | 3 | corpus prune |
| `EASY_MS` | 2500 | FSRS Easy grade (ADR 0003) |

### Shipping

- **The dataset ships:**
  - hub and system definitions: σ, approach, defining choices, names, aliases
  - per-course summaries: tier sizes, coverage, average depth, games, W/D/L, line IDs per chapter
  - the position→best-course index
- **Course trees and lines are not shipped.** The client derives them on demand with the same pure function, deterministic for a given `outputHash`. Line IDs computed by the client equal those in the summaries; a unit test asserts this.
- **Why:** shipping every course's lines for both sides would blow the 700 KB gzip budget. Derivation is a few milliseconds per course.

## Consequences

- One code path for default and personalised courses.
- The catalog stops at hubs, so 1–2-ply families never head it.
- Variant systems add courses, but share cards with their parents, so they cost no extra reviews for shared positions.
- Open risk: very large hubs (Sicilian ≈ 400 rows) may produce many variants. Phase 2 reports the counts and adjusts the tunables.

---

## Phase 2 amendments (implemented 2026-10-18)

These are decisions made while implementing, with the reason for each. Deviations from the spec are marked **DEVIATION**.

1. **Reach counts from σ (spec §4.6).** Amends the approach-node rule above.
   - Approach nodes are neutral, so σ-lines sum to 1.
   - **Early-deviation lines** get *local* reach: the deviating move's share at the divergence node, times the factors after it. They sort after every σ-line and appear only in the Complete tier.
   - Why: with root-based reach, QGD-named rows starting 1.c4 took 19% of the Essentials mass.
2. **Tiers are chosen on trainable mass** (kept σ-lines). Coverage is still reported against *all* master games after σ, folded lines included.
   - Why: in data-sparse hubs (King's Gambit), many rare unanswered replies get folded. Counting them in the selection target pushed every tier to its cap. The honest coverage number stays: King's Gambit Essentials covers 39%.
3. **Systems.**
   - Named after the position their defining moves reach ("Najdorf Variation"). Falls back to the ≥ 80% common name, then the defining moves.
   - Ordered by the games of each defining choice, compared in order (lexicographically). "Recommended" = the first root whose course has ≥ `RECOMMENDED_MIN_LINES` (3) σ-lines, else the root with the most σ-lines.
   - Why: the earlier signature-games ordering favoured shallow systems (it recommended 2…Nc6 over the Najdorf). The line minimum stops a stub from leading. Example: KID as White, 5.Be2 (220 games) beats 5.Nf3 (178) by move games, but its main line transposes into 5.Nf3 and leaves a 1-line course. On the shipped data, 8 curated hub/side pairs changed recommendation (KID, Grünfeld and Pirc as White; Philidor, Scandinavian, Trompowsky, Old Indian and Réti as Black).
   - Learner choices are taken within 4 learner moves of σ and qualify with ≥ `SYSTEM_MIN_ROWS` (3) rows or ≥ 10% of hub rows. A system stops at a path whose name leaves the hub.
4. **Chapter and section names.**
   - A chapter is named after the position its key move reaches, whenever that name says more than its parent (the hub for chapters, the chapter for sections). Otherwise the ≥ 60% shared name is used, then "Main line (key)" or "key line".
   - Line names drop the most specific context that prefixes them (section › chapter › system).
   - Names that repeat the hub title as a later segment ("Queen's Pawn Game, London System") are cut after it.
5. **Variant systems — DEVIATION (spec has none; proposed in Phase 0).**
   - Greedy set cover in batched rounds: each round takes every best non-overlapping candidate. Candidates start at the row's attachment point.
   - A detour that rejoins the course later (an EPD transposition) is skipped: the candidate is taken where the row finally leaves the course. If that finds none, the first deviation is used.
   - A variant is kept only if it gets further along at least one target row than its parent, and its line set (folded lines included) duplicates no other course.
   - Caps: `VARIANT_MAX_PER_SYSTEM` 30 per root system, `VARIANT_MAX_TOTAL` 400.
   - Result: 262 variants across 971 systems. Without them, 485 rows were unassigned.
6. **Folded lines count as reachable notes.** A course whose lines all have < 2 learner moves after σ keeps all of them unfolded.
   - Result: 3,508 rows on course lines and 357 reachable only as folded notes. **0 unassigned.**
7. **Auto hubs group by the first name segment** ("London System, with Be2" → "London System"), not by the text before the colon. Many lichess families are no-colon names with commas.
8. **London signature** = `1.d4 d5 2.Nf3 Nf6 3.Bf4`, the classic set-up.
   - The first attempt, `1.d4 d5 2.Bf4`, only covers the tiny Accelerated-London subtree in lichess naming.
   - The `2.Bf4` rows form the linked sibling hub; the `1…Nf6` rows are early deviations.
9. **Shipping.** The catalog ships hub, system and course summaries, plus each hub's *seed* (row indices and primary name).
   - The client rebuilds only the hub it needs, then derives the course. The same lines are guaranteed by a unit test over 37 sampled courses and 10 variants.
10. **Dev watcher memo.** Courses are memoised by a content signature of their hub, in EPD terms, and remapped by EPD when node indices shift.
    - A unit test asserts memo builds are byte-identical to fresh builds, including an `a.tsv` insertion.
11. **Small sibling groups** (< `SIBLING_MIN_ROWS` rows) become Offbeat hubs. They are listed on the parent hub as `minorSiblings` and linked under "Related openings".
    - Per-hub coverage counts the hub's own courses plus all its siblings, recursively, minor ones included.
    - Why: Queen's Indian "with e3" rows live two levels down (QID › with e3 › 5…Bd6). Users reach them from the QID page.
12. **Curated additions:** `neo-grunfeld-defense`, `pterodactyl-defense` and `old-indian-defense`, each with an explicit signature (spec §4.4's expected odd cases). Every curated hub is now ≥ 95% covered. The build prints **0 warnings**.
13. **Input hash includes the build code** (`codeHash`: `src/lib/openings-build/*.ts` + `src/content/hubs.ts`). A logic change can't be skipped by the up-to-date shortcut.
14. **Annotations** (`public/data/annotations/*.pgn`) are parsed into the dataset (`annotations`, keyed `EPD|SAN`). The v1 notes were migrated to `curated.pgn` (74 notes). One v1 key was illegal (`e4 e6 d5`) and was corrected to `e4 e6 d4`.
15. **Dev watcher V8 flags:** `--no-flush-bytecode --no-memory-reducer`.
    - While idle, V8 dropped the warm build code and shrank the ~340 MB heap (≈ 3 s of idle GC CPU). The first edit after a pause then took 2.4–6.6 s instead of ~1 s.
    - Tailwind's automatic source detection no longer scans `public/data` and `data/` (`@source not`). Before, every artifact write recompiled `globals.css` in dev.

### Measured (2026-10-18, this VM)

| | |
|---|---|
| Hubs | 197: 43 curated, 89 auto, 65 sibling. 48 top-level, 149 offbeat |
| Systems | 971 (262 variants) |
| Lines | 9,689 |
| Extension plies | 13,280 |
| Dataset | 2.27 MB raw / 401 KB gzip (budget 700 KB) |
| Cold `openings:build` | 3.5–9.8 s (identical input; see the VM note) |
| Watcher incremental | 0.6–2.0 s typical. A Ruy Lopez edit reuses 949 of 983 course derivations: the 971 kept courses plus rejected variant trials |

**VM note.** Late in Phase 2 this VM began faulting fresh memory at ~25 µs/page: 1 GB took 26.7 s, against ≈ 0.2 s normally. All timings above swing 2–3× run to run. Earlier in the phase, the same live E2E passed at 1.7–2.0 s (course) and 2.2–2.6 s (hub badge).
