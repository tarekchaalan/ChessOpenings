#!/usr/bin/env node
/**
 * A stand-in for Supabase in the e2e suite: a LOCAL Postgres with the real
 * migrations (0001–0008), behind just enough of PostgREST and GoTrue for the
 * browser client (supabase-js). Signed-in tests therefore run against the
 * real RLS policies and SECURITY DEFINER functions, not mocks.
 *
 *   - GoTrue: password sign-in, refresh, /user, logout. Tokens are unsigned
 *     JWTs: this server trusts them, and it only listens on 127.0.0.1.
 *   - PostgREST: POST /rest/v1/rpc/<fn>, and GET on tables and views with
 *     eq/neq/lt/lte/gt/gte/is/in/not.is filters, order, limit/offset, single
 *     object responses and exact counts. Each request runs as `anon` or
 *     `authenticated` with request.jwt.claim.sub set, like PostgREST.
 *   - POST /__e2e/reset recreates the database's users and data (fixtures below).
 *
 * Needs psql and a local Postgres 16: DATABASE_URL (default
 * postgres://postgres@127.0.0.1:54329/postgres), started with
 * scripts/supabase/local-pg.sh when it isn't running. Refuses non-local hosts.
 */
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const PORT = Number(process.env.E2E_SUPABASE_PORT ?? 54398);
const BASE = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/postgres";
const host = new URL(BASE).hostname;
if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
  console.error(`supabase-stub: refusing non-local host "${host}"`);
  process.exit(1);
}
const DB_URL = (() => {
  const u = new URL(BASE);
  u.pathname = "/cot_e2e";
  return u.toString();
})();

// ── psql ────────────────────────────────────────────────────────────────
function psql(url, sql, { file } = {}) {
  const args = ["-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", url, ...(file ? ["-f", file] : ["-c", sql])];
  return new Promise((resolve, reject) => {
    execFile("psql", args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const m = /ERROR:\s+([0-9A-Z]{5}):\s+(.*)/.exec(stderr);
        const d = /DETAIL:\s+(.*)/.exec(stderr);
        reject({ code: m?.[1] ?? "XX000", message: m?.[2] ?? stderr.trim(), details: d?.[1] ?? null });
      } else resolve(stdout.trim());
    });
  });
}
const sh = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, (e, out, err) => (e ? reject(new Error(err || e.message)) : resolve(out))));

const lit = (v) => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  const s = typeof v === "string" ? v : JSON.stringify(v);
  if (s.includes("\u0000")) throw { code: "22021", message: "NUL in input" };
  return `'${s.replace(/'/g, "''")}'`;
};
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw { code: "42602", message: `bad identifier ${s}` };
  return s;
};

// ── tokens ──────────────────────────────────────────────────────────────
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jwt = (claims) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.e2e`;
export const ANON_KEY = jwt({ role: "anon", iss: "supabase-stub", exp: 4102444800 });
function claimsOf(req) {
  const h = req.headers.authorization ?? "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : req.headers.apikey ?? "";
  try {
    return JSON.parse(Buffer.from(String(t).split(".")[1] ?? "", "base64url").toString());
  } catch {
    return { role: "anon" };
  }
}
const userJson = (u) => ({
  id: u.id,
  aud: "authenticated",
  role: "authenticated",
  email: u.email,
  email_confirmed_at: u.created_at,
  app_metadata: { provider: "email", providers: ["email"] },
  user_metadata: u.raw_user_meta_data ?? {},
  created_at: u.created_at,
  updated_at: u.created_at,
});
async function userById(id) {
  const out = await psql(DB_URL, `select row_to_json(u) from auth.users u where id = ${lit(id)}`);
  return out ? JSON.parse(out) : null;
}
function session(u) {
  const now = Math.floor(Date.now() / 1000);
  const access = jwt({ sub: u.id, email: u.email, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600, session_id: u.id });
  return { access_token: access, token_type: "bearer", expires_in: 3600, expires_at: now + 3600, refresh_token: `r.${u.id}`, user: userJson(u) };
}

// ── database lifecycle ──────────────────────────────────────────────────
async function ensurePostgres() {
  try {
    await psql(BASE, "select 1");
  } catch {
    await sh(join(ROOT, "scripts/supabase/local-pg.sh"), ["start"]);
    await psql(BASE, "select 1");
  }
}
async function createDb() {
  await psql(BASE, "drop database if exists cot_e2e with (force)");
  await psql(BASE, "create database cot_e2e");
  await psql(DB_URL, null, { file: join(ROOT, "scripts/supabase/local-shim.sql") });
  const dir = join(ROOT, "supabase/migrations");
  for (const f of readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) await psql(DB_URL, null, { file: join(dir, f) });
}

/** Fixture players (password for all: "password1!"). */
const FIXTURE = `
truncate auth.users cascade;
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-0000000000a1', 'alice@e2e.test', '{"username":"alice"}'),
  ('00000000-0000-0000-0000-0000000000b2', 'bob@e2e.test', '{"username":"bob"}'),
  ('00000000-0000-0000-0000-0000000000c3', 'carol@e2e.test', '{"username":"carol"}');
update profiles set rating = 1210, attempts = 40, correct = 30 where username = 'alice';
update profiles set rating = 1340, attempts = 60, correct = 50 where username = 'bob';
update profiles set rating = 990, attempts = 12, correct = 6 where username = 'carol';
insert into linked_accounts (user_id, platform, username, ratings) values
  ('00000000-0000-0000-0000-0000000000a1', 'lichess', 'alice_li', '{"blitz":{"rating":1650,"games":300,"provisional":false}}'),
  ('00000000-0000-0000-0000-0000000000a1', 'chesscom', 'alice_cc', '{"rapid":{"rating":1500,"games":80,"provisional":false}}'),
  ('00000000-0000-0000-0000-0000000000b2', 'lichess', 'bob_li', '{"blitz":{"rating":1720,"games":900,"provisional":false}}'),
  ('00000000-0000-0000-0000-0000000000b2', 'chesscom', 'bob_cc', '{"rapid":{"rating":1610,"games":50,"provisional":false}}');
insert into game_summaries (user_id, platform, game_id, color, time_class, played_at, result, eco, opening_name, opening_plies, book_ply, deviated_by, dataset_hash)
values ('00000000-0000-0000-0000-0000000000b2', 'lichess', 'BBBBBBBB', 'white', 'blitz', now(), 'win', 'C50', 'Italian Game', array['e4','e5','Nf3','Nc6','Bc4'], 5, 'none', 'h');
insert into course_progress (user_id, course_id, seen, correct, mastery, updated_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'italian-game/main@white', 20, 15, 0.3, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000000b2', 'italian-game/main@white', 40, 36, 0.6, now()),
  ('00000000-0000-0000-0000-0000000000b2', 'sicilian-defense/najdorf@black', 10, 7, 0.1, now() - interval '2 days');
insert into quiz_attempts (user_id, epd, san, correct, ms, rating_before, rating_after, course_id, line_id, created_at)
select '00000000-0000-0000-0000-0000000000b2', 'x', 'e4', true, 1000, 1300, 1301, 'italian-game/main@white', 'line-' || i, now() - interval '20 minutes' + i * interval '1 minute'
from generate_series(1, 3) i;
`;
async function reset() {
  await psql(DB_URL, FIXTURE);
}

// ── PostgREST subset ────────────────────────────────────────────────────
async function asRole(claims, sql) {
  const sub = claims.role === "authenticated" && claims.sub ? claims.sub : "";
  const role = sub ? "authenticated" : "anon";
  // SET statements print nothing, so the query's result is the only output
  return psql(DB_URL, `begin; set local role ${role}; set local "request.jwt.claim.sub" = ${lit(sub)}; ${sql}; commit;`);
}

function filterSql(col, raw) {
  const c = ident(col);
  let neg = false;
  let v = raw;
  if (v.startsWith("not.")) {
    neg = true;
    v = v.slice(4);
  }
  const dot = v.indexOf(".");
  const op = v.slice(0, dot);
  const val = v.slice(dot + 1);
  const ops = { eq: "=", neq: "<>", lt: "<", lte: "<=", gt: ">", gte: ">=" };
  let expr;
  if (ops[op]) expr = `${c} ${ops[op]} ${lit(val)}`;
  else if (op === "is") expr = `${c} is ${val === "null" ? "null" : val === "true" ? "true" : "false"}`;
  else if (op === "in") expr = `${c} in (${val.replace(/^\(|\)$/g, "").split(",").map((x) => lit(x.replace(/^"|"$/g, ""))).join(", ")})`;
  else throw { code: "PGRST100", message: `unsupported operator ${op}` };
  return neg ? `not (${expr})` : expr;
}

async function restGet(req, res, table, url) {
  const claims = claimsOf(req);
  const t = ident(table);
  const params = url.searchParams;
  const select = (params.get("select") ?? "*").split(",").map((s) => s.trim()).filter(Boolean);
  const cols = select.length === 0 || select.includes("*") ? "*" : select.map(ident).join(", ");
  const where = [];
  let order = "";
  let limit = "";
  let offset = "";
  for (const [k, v] of params) {
    if (k === "select") continue;
    else if (k === "order")
      order = ` order by ${v.split(",").map((o) => {
        const [c, dir, nulls] = o.split(".");
        return `${ident(c)} ${dir === "desc" ? "desc" : "asc"}${nulls === "nullsfirst" ? " nulls first" : nulls === "nullslast" ? " nulls last" : ""}`;
      }).join(", ")}`;
    else if (k === "limit") limit = ` limit ${Number(v) | 0}`;
    else if (k === "offset") offset = ` offset ${Number(v) | 0}`;
    else where.push(filterSql(k, v));
  }
  const range = /^(\d+)-(\d+)$/.exec(String(req.headers.range ?? ""));
  if (range) {
    offset = ` offset ${range[1]}`;
    limit = ` limit ${Number(range[2]) - Number(range[1]) + 1}`;
  }
  const w = where.length ? ` where ${where.join(" and ")}` : "";
  const base = `select ${cols} from public.${t}${w}`;
  const prefer = String(req.headers.prefer ?? "");
  const out = await asRole(claims, `select json_build_object('rows', coalesce((select json_agg(x) from (${base}${order}${limit}${offset}) x), '[]'::json), 'count', ${prefer.includes("count=") ? `(select count(*) from (${base}) c)` : "null"})`);
  const { rows, count } = JSON.parse(out);
  const headers = {};
  if (count !== null) headers["content-range"] = `${rows.length ? `0-${rows.length - 1}` : "*"}/${count}`;
  if (String(req.headers.accept ?? "").includes("vnd.pgrst.object")) {
    if (rows.length !== 1) return send(res, 406, { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned", details: `The result contains ${rows.length} rows`, hint: null }, headers);
    return send(res, 200, rows[0], headers);
  }
  return send(res, req.method === "HEAD" ? 200 : 200, req.method === "HEAD" ? undefined : rows, headers);
}

async function rpc(req, res, fn) {
  const claims = claimsOf(req);
  const body = await readJson(req);
  const args = Object.entries(body ?? {}).map(([k, v]) => `${ident(k)} => ${lit(v)}`).join(", ");
  const out = await asRole(claims, `select to_json(public.${ident(fn)}(${args}))`);
  return send(res, 200, out === "" ? null : JSON.parse(out));
}

// ── HTTP ────────────────────────────────────────────────────────────────
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, apikey, content-type, prefer, range, accept, accept-profile, content-profile, x-client-info, x-supabase-api-version",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, HEAD, OPTIONS",
  "access-control-expose-headers": "content-range",
};
function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...CORS, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}
function readJson(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => {
      try {
        resolve(s ? JSON.parse(s) : {});
      } catch {
        resolve({});
      }
    });
  });
}
const pgStatus = (code) => (code === "42501" ? 403 : code === "P0002" ? 404 : code?.startsWith("PGRST") ? 400 : code === "42883" ? 404 : 400);

async function handle(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  if (req.method === "OPTIONS") return send(res, 204);
  if (p === "/health") return send(res, 200, { ok: true, anonKey: ANON_KEY });
  if (p === "/__e2e/reset" && req.method === "POST") {
    await reset();
    return send(res, 200, { ok: true });
  }
  if (p === "/__e2e/sql" && req.method === "POST") {
    const { sql } = await readJson(req);
    return send(res, 200, { out: await psql(DB_URL, sql) });
  }
  // GoTrue
  if (p === "/auth/v1/token") {
    const body = await readJson(req);
    const grant = url.searchParams.get("grant_type");
    let u = null;
    if (grant === "password") {
      const out = await psql(DB_URL, `select row_to_json(u) from auth.users u where lower(email) = lower(${lit(body.email ?? "")})`);
      u = out && body.password === "password1!" ? JSON.parse(out) : null;
    } else if (grant === "refresh_token" && String(body.refresh_token ?? "").startsWith("r.")) {
      u = await userById(String(body.refresh_token).slice(2));
    }
    if (!u) return send(res, 400, { error: "invalid_grant", error_description: "Invalid login credentials", code: "invalid_credentials", msg: "Invalid login credentials" });
    return send(res, 200, session(u));
  }
  if (p === "/auth/v1/user") {
    const c = claimsOf(req);
    const u = c.sub ? await userById(c.sub) : null;
    if (!u) return send(res, 401, { code: "user_not_found", msg: "User not found" });
    return send(res, 200, userJson(u));
  }
  if (p === "/auth/v1/logout") return send(res, 204);
  // PostgREST
  const m = /^\/rest\/v1\/(rpc\/)?([a-z_][a-z0-9_]*)$/.exec(p);
  if (m) {
    if (m[1]) return rpc(req, res, m[2]);
    if (req.method === "GET" || req.method === "HEAD") return restGet(req, res, m[2], url);
    return send(res, 405, { code: "PGRST000", message: `${req.method} is not supported by the e2e stub` });
  }
  return send(res, 404, { message: `no route ${p}` });
}

await ensurePostgres();
await createDb();
await reset();
createServer((req, res) => {
  handle(req, res).catch((e) => {
    const err = e && typeof e === "object" && "code" in e ? e : { code: "XX000", message: String(e?.message ?? e) };
    send(res, pgStatus(err.code), { code: err.code, message: err.message, details: err.details ?? null, hint: null });
  });
}).listen(PORT, "127.0.0.1", () => console.log(`supabase-stub on http://127.0.0.1:${PORT}`));
