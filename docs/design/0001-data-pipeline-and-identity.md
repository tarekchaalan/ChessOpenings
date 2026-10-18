# ADR 0001 — Data pipeline and stable identity

- **Status:** accepted (Phase 0). Amended in later phases where noted.
- **Spec:** `docs/prompts/opening-trainer-v2.md` §4.1, §4.3, §4.6, §4.8.

## Context

- v1 bakes a pinned lichess snapshot into `openings.v1.json` with `scripts/ingest.ts`.
- Progress, URLs and the server all key on the row's **array index** (defect 1). Any data change silently re-attaches progress to the wrong opening.
- Stats come from a corpus pass that only counts games while they are "in book". New lines therefore have no stats unless the 110 MB corpus is re-streamed.
- `public/data/all-openings/` (the lichess `master` TSVs) is now the source of truth, and edits must show up live in dev.

## Decision

### Layering

| Layer | Location | Rules |
|---|---|---|
| Pure build library | `src/lib/openings-build/` | No Node APIs (no `fs`, `crypto`, `zlib`). Runs in Node, the browser and Vitest. Contains: TSV parse, PGN/annotation parse, replay (with a prefix-shared replay cache), graph, ids (pure-TS SHA-256 + RFC 4648 base32), stats join, extension, hubs/systems/courses/lines, diff, validation. |
| Node adapters | `scripts/openings/` | `build.ts` (one-shot), `check.ts`, `watch.ts`, `corpus.ts` (position stats), `dev.ts` (runs `next dev` + watcher), `fsutil.ts` (walk/read/hash/gzip). |
| Runtime | `src/lib/openings.ts` (v2 loader) | Parses `openings.v2.json` into an indexed `Dataset`. Re-derives courses with the same pure library. |

**Why a pure library?** The same code builds artifacts, re-derives a course on the client when a user has overrides (§4.5), and runs in unit tests with no mocks.

### Source contract (§4.1)

- **Files:** `*.tsv` (case-insensitive), walked recursively, sorted by POSIX relative path. Any other file → warning `ignored non-TSV file <path>`.
- **Parsing:**
  - Strip the BOM; accept LF or CRLF; skip blank lines and lines starting with `#`.
  - The header is required. Columns are matched by name; `eco`, `name` and `pgn` are required; other columns go to `extra`.
- **PGN tokens:** drop move numbers (`1.`, `1...`, glued `12.e4`), results, NAGs and `!?`-style suffixes. Replay with chess.js.
- **Normalised SAN** = the SAN **chess.js produces on replay**, with `+#` stripped. It is never the raw token. `Nbd2` written as `Nd2` (when unambiguous) or `0-0` written as `O-O` therefore yields the same row ID, and reformatting a TSV never changes identity. Row IDs and duplicate detection hash this sequence. Display uses the chess.js SAN with `+`/`#`.
- **Validation:**

  | Problem | Level | Effect |
  |---|---|---|
  | Illegal SAN | error | `file:line`, ply index, token. Row skipped. |
  | Empty name | error | Row skipped. |
  | Bad or missing ECO | warning | Row kept with `eco: null`. |
  | Duplicate normalised SAN sequence | warning | First row wins (deterministic order); later names become `aliases`. |
  | Same final position via different move orders | — | Both rows kept. The position's display name is the row with the shortest path (ties → first). |

- Errors never stop the build. `openings:check` exits 1 when there are errors. The dev watcher keeps the last good artifacts when errors appear.

### Identity (§4.3)

| ID | Definition | Notes |
|---|---|---|
| `rowId` | `rw_` + `base32(sha256(normSans.join(" ")))[0:12]` | 60 bits. Uniqueness asserted in the build. Rename = same `rowId`, new name. |
| `lineId` | `ln_` + `base32(sha256(courseId + "\n" + namedSans.join(" ") + suffix))[0:12]` | `namedSans` = the line's SAN path from the start position, **excluding** `ext` plies. `suffix` is empty unless two lines in the course share the same named path (possible, because extension can branch twice at the opponent's moves). Only then is `"\n" + extSans.join(" ")` appended, to each colliding line. Stable while the named theory along the path is unchanged. Uniqueness per course is asserted. A line also lists the `rowId`s it realises. |
| Position key | EPD (FEN without the clocks) | As in v1. Node indices are build-local, never persisted. |
| Hub ID | readable slug | Curated in `src/content/hubs.ts`; auto hubs use `slug(family)`. |
| Course ID | `<hubSlug>/<systemSlug>@<side>` | Path `/openings/[hub]/[system]/[side]`. A course ID is never put into one dynamic segment. |
| SRS card key | `(side, EPD, answerSAN)` | Shared across courses. See ADR 0003. |

**Slug stability.**
- The system slug comes from the system's **defining SAN path relative to σ** (e.g. `najdorf` from the common name when it is unique within the hub, else the defining moves, e.g. `5-a6`).
- Slug aliases are **cumulative and committed**: `src/content/slug-aliases.json` keeps every course and hub ID ever emitted, mapped to its current successor. Hubs need this too, because an auto hub disappears when a curated hub claims its family. When a course ID is aliased, its line IDs change; the client re-maps `lastLineId` by matching the named SAN path.
- Every build appends to that map (old slug → new slug) into the dataset whenever a previously emitted course ID disappears but its signature EPD survives in another system. The client resolves unknown course IDs through this map and shows a notice.

### Position statistics (§4.6)

- `npm run corpus:build` streams the pinned lichess broadcast months from `data/cache/` (Elo ≥ 2200 both sides, de-duplicated as in v1) into a table keyed by `EPD → {games, w, d, b, moves: SAN → {games, w, d, b}}`.
  - It counts **every** position up to `maxPly`, not only in-book ones. It prunes moves with < 3 games and positions with < 3 games.
- Output: `data/derived/position-stats.v1.json.gz` plus `position-stats.v1.meta.json` (source pins, sha256, counts, `maxPly`). Budget ≤ 3 MB, committed.
- `maxPly = max(30, deepestRow + 2)` is fixed when the table is built (today 38). The meta records it.
  - If a later TSV row is deeper than `maxPly − 2`, the build warns "position stats are shallower than the data; re-run corpus:build". Extension (§4.7) still never goes past the recorded `maxPly`.
- Decompression: the `zstd` CLI when available, else `fzstd` (pure JS, MIT). Node's built-in zstd can't read the multi-frame dumps.
- `openings:build` joins stats by EPD lookup. It never touches the corpus, so new rows get stats instantly.

### Build artifacts (§4.8)

| File | Content |
|---|---|
| `public/data/openings.v2.json` | `format: "chess-openings-trainer/graph@2"`: rows, nodes (theory edges + stats moves + extension edges), hubs, systems, course summaries, the position→course index and annotations. Compact array tuples, as in v1. |
| `public/data/openings.v2.meta.json` | `inputHash` (sha256 over sorted relative paths + contents of all watched inputs + position-stats sha + `BUILD_LIB_VERSION`), `outputHash`, counts, warnings, errors, `unassigned`, timings. |
| `public/data/openings.changelog.json` | Diff vs the previous build. The baseline for the first build is the rows in the committed `openings.v1.json`. Contains added / removed / renamed rows plus per-hub and per-course line deltas. Keeps the last 20 entries. |
| `public/data/legacy-map.v1.json` | v1 index → `{rowId, finalEpd, sans, bestCourseId, bestLineId}` |
| `supabase/seed/*.sql` | v2 theory tables (ADR 0004), in < 1 MB files |

- **Determinism:** the same inputs produce byte-identical outputs. Timings live in meta only, outside `outputHash`; `builtAt` is not part of any hash.
- `openings:check` recomputes `inputHash` and exits 1 if it differs from the committed meta or if the build has errors. It runs in `npm run lint`.

### Live reload

- `predev` and `prebuild` run `openings:build` (one-shot), so `next dev` and `next build` always start from fresh artifacts.
- `npm run dev` runs `scripts/openings/dev.ts`, a tiny runner that spawns `next dev` and the watcher and forwards signals. **No `concurrently` dependency.**
- The watcher uses `chokidar` (MIT) with `awaitWriteFinish`. Justification: atomic-save renames and partial writes are exactly what raw `fs.watch` gets wrong across platforms.
  - It watches `public/data/all-openings/**` and `public/data/annotations/**`, debounced 300 ms.
  - It keeps a replay cache keyed by the raw PGN string, plus a SAN-prefix trie of chess.js states, so an edit replays only changed rows.
  - Artifacts are written atomically: tmp file + rename. The JSON is written before the meta, so a client that sees a new hash can always fetch the matching JSON.
- The dev-only SSE route `GET /api/dev/openings` (404 when `NODE_ENV !== "development"`) `fs.watch`es `openings.v2.meta.json` and pushes `{outputHash}`. The client reloads `openings.v2.json?v=<hash>` in place and shows the diff toast.
- In production, the client re-checks the meta on window focus at most every 10 min. `prebuild` runs `openings:build`, so deployments always ship fresh artifacts.

### Legacy

- `openings.v1.json` stays committed until the Phase 5 migration ships. It is the changelog baseline and the source for `legacy-map.v1.json`.
- `/learn/[id]` and `/quiz/[id]` redirect through the legacy map (Phase 4).

## Consequences

- Progress can never silently move: cards key on positions, and courses and lines key on content hashes.
- Builds are fast enough to run on every save, because the corpus step is separated out.
- New dependencies:
  - `fzstd` (MIT), dev-only, corpus decoding
  - `chokidar` (MIT), dev watcher
  - `vitest` (MIT) and `@playwright/test` (Apache-2.0), testing
- Risk: a 60-bit row-ID collision is astronomically unlikely, and it is asserted anyway.
