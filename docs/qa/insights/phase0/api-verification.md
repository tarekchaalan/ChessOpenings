# Phase 0 — API verification (2026-10-19)

Live requests from the dev container, plus the current docs. Trimmed responses
are checked in as test fixtures in `src/lib/insights/__tests__/fixtures/`.
All accounts used are public titled players (Lichess `Zhigalko_Sergei`,
Chess.com `hikaru`).

## Lichess

| Check | Result | Source |
|---|---|---|
| `GET /api/user/{u}` | 200, JSON. `perfs.{bullet,blitz,rapid,classical}` = `{games, rating, rd, prog, prov?}`. `prov: true` marks a provisional rating. | `fixtures/lichess-user.json` |
| Unknown user | `GET /api/user/{u}` → **404** `{"error":"Not found"}`. `GET /api/games/user/{u}` → **404** with the same body. | `fixtures/lichess-user-404.json` |
| `GET /api/games/user/{u}` with `Accept: application/x-ndjson` | 200, `application/x-ndjson; charset=utf-8`, one game per line, newest first. | `fixtures/lichess-games.ndjson` |
| Params used | `since` (ms), `max`, `rated=true`, `perfType=blitz,rapid,classical` (comma list), `opening=true`, `evals=true`, `moves=true`. All honoured. | OpenAPI `api-games-user-username.yaml` |
| Game fields | `id, rated, variant, speed, perf, createdAt, lastMoveAt, status, source, players.{white,black}.{user.{name,id,title?}, rating, ratingDiff, analysis?}, winner? (absent = draw), opening.{eco,name,ply}, moves (space-separated SAN), clock, analysis?` | fixture |
| `analysis` (with `evals=true`) | One entry per ply: `{eval}` (cp, White's side) or `{mate}`, plus `best`, `variation` and `judgment.{name,comment}` on flagged moves. Present only when the game has server analysis. All 43 games in the 3-month sample had it (a titled player's games); expect far fewer for ordinary accounts. | fixture |
| Throughput | Docs: anonymous **20 games/s**, OAuth 30, own games with OAuth 60. Observed: 43 games in 2.6 s. A 200-game import is about 10 s anonymous. | OpenAPI description |
| Rate limits | Docs: "Only make one request at a time." On 429, "waiting one minute before retrying will be sufficient, but some limits may require longer." | OpenAPI description |
| CORS | `access-control-allow-origin: *` on both endpoints. `Accept` is a CORS-safelisted header, so a browser GET needs no preflight. | response headers |
| Opening explorer for rating bands | `explorer.lichess.ovh/lichess?ratings=…` → **401** without a token. It can't feed the band-specific scores in spec §3.3 anonymously. | live request |

## Chess.com (Published-Data API)

| Check | Result | Source |
|---|---|---|
| `GET /pub/player/{u}` | 200, profile JSON (`username`, `player_id`, `title`, `status`, …). | `fixtures/chesscom-player.json` |
| Unknown user | **404** `{"code":0,"message":"User \"…\" not found."}`, also for `/games/archives`. | `fixtures/chesscom-404.json` |
| `GET /pub/player/{u}/stats` | `chess_{bullet,blitz,rapid,daily}.last.{rating,date,rd}`, `best`, `record`. | `fixtures/chesscom-stats.json` |
| `GET /pub/player/{u}/games/archives` | `{archives: [url…]}`, oldest first, one URL per month. | `fixtures/chesscom-archives.json` |
| `GET …/games/{YYYY}/{MM}` | `{games: [...]}`. Per game: `url, pgn, time_control, end_time (s), rated, accuracies?, tcn, uuid, initial_setup, fen, time_class, rules, white/black.{rating, result, @id, username, uuid}, eco (an opening URL, not a code), tournament?/match?`. The ECO code is only in the PGN `[ECO]` tag. | `fixtures/chesscom-month.json` |
| Docs vs reality | The docs list `time_class`, `rated` and `uuid` for the time-control archive only; the monthly archive returns all three. The parser must still tolerate their absence. | live |
| Filter values seen | `rules`: `chess`, `chess960`. `time_class`: `bullet`, `blitz`, `rapid`, `daily`. `rated: false` games exist. All are in the fixture. | live, months 2014-04, 2015-10, 2026-08, 2026-09 |
| Result codes | In the fixture: `win, resigned, checkmated, timeout, insufficient`. The parser maps a game to win/loss when one side has `win`, and otherwise to a draw, so other draw codes (`agreed`, `repetition`, `stalemate`, …) need no list. | fixture |
| Size | A heavy month (509 games) is **2.1 MB**, about 4 KB per game. Typical accounts are much smaller. | live |
| Caching | `ETag` + `Last-Modified`; `If-None-Match` returned **304**. `cache-control: public, max-age=5` (month), `max-age=60` (archives). | live |
| Refresh delay | The docs contradict themselves ("at most once every 12 hours" vs "24 hours"). The current month's `Last-Modified` was under an hour old. Treat new games as possibly delayed. | docs + live |
| Rate limits | Docs: "Your serial access rate is unlimited"; parallel requests may get 429. | docs |
| User-Agent | Docs: recommended ("a recognizable user-agent that contains contact information"), **not required**. | docs |
| CORS | `access-control-allow-origin: *`. The docs also say the endpoints "can be called, by any kind of client or browsers". | response headers + docs |

## Book-matching probe against the current dataset

A throwaway script (not committed) walked the fixture games through
`modelFromRaw(openings.v2.json)` with the walk in ADR 0006 §Book matching:

- Out-of-book ply for the 15 Lichess games: 3–12. For the 15 standard Chess.com games: 2–16.
- 4 of 15 Lichess and 3 of 15 Chess.com final book positions have no
  `catalog.pos` entry for the side to move. Overall, **6,917 of 9,934** nodes
  have one, so deep links need the fallback in ADR 0006 §Deep links.
- Hikaru leaves book at ply 2–3 in several games (`1.e4 c5 2.c3 Qa5`). A
  "non-book move" is therefore not a "mistake" by itself; see ADR 0006
  §Repeat mistakes.
