/**
 * Generates a real v1 guest localStorage snapshot for the migration tests
 * (§4.9): the v1 quiz engine (LocalQuizBackend + SM-2 + local progress) is
 * driven through several openings over several simulated days, against an
 * in-memory localStorage. Deterministic (seeded random, fixed clock).
 *
 *   npx tsx scripts/progress/make-v1-fixture.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(__dirname, "../../src/lib/progress/__tests__/fixtures/v1-localStorage.json");

// ── environment: localStorage, a seeded Math.random, a settable clock ──────
const store = new Map<string, string>();
const localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
Object.assign(globalThis, { window: globalThis, localStorage });

let seed = 20261018;
Math.random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const RealDate = Date;
let clock = new RealDate("2026-03-02T18:00:00Z").getTime();
class FakeDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(clock);
    else super(...(args as [string]));
  }
  static now() {
    return clock;
  }
}
globalThis.Date = FakeDate as DateConstructor;

async function main() {
  const { parseDataset } = await import("../../src/lib/openings");
  const { LocalQuizBackend } = await import("../../src/lib/quiz/local");
  const raw = JSON.parse(readFileSync(join(__dirname, "../../public/data/openings.v1.json"), "utf8"));
  const ds = parseDataset(raw);
  const byName = (name: string) => {
    const o = ds.openings.find((x) => x.name === name);
    if (!o) throw new Error(`no v1 opening "${name}"`);
    return o.id;
  };
  const backend = new LocalQuizBackend(ds);

  /** One quiz session: `lines` lines, answering correctly with probability `acc`. */
  async function session(openingId: number, side: "white" | "black", lines: number, acc: number) {
    for (let l = 0; l < lines; l++) {
      let ch = await backend.issue(openingId, side, null);
      while (!ch.done) {
        const pending = (backend as unknown as { pending: Map<string, { expected: { san: string }[] }> }).pending.get(ch.id)!;
        const good = Math.random() < acc;
        const san = good ? pending.expected[0].san : "a3";
        const ms = 1500 + Math.floor(Math.random() * 9000);
        const r = await backend.answer(ch.id, san, ms, false);
        clock += 20_000;
        if (!r.correct || !r.lineContinues) break;
        ch = await backend.issue(openingId, side, ch.id);
      }
    }
  }

  const plan: { name: string; side: "white" | "black" }[] = [
    { name: "Ruy Lopez", side: "white" },
    { name: "Ruy Lopez: Closed", side: "white" }, // shares early positions with the above (merge rule)
    { name: "Sicilian Defense: Najdorf Variation", side: "black" },
    { name: "Queen's Gambit Declined", side: "black" },
    { name: "Italian Game", side: "white" },
  ];
  const ids = plan.map((p) => byName(p.name));
  const DAY = 86400_000;
  // day 0, 1, 7, 20, 45: each opening practised on some of them
  for (const [d, accs] of [
    [0, [0.8, 0.8, 0.7, 0.9, 0.85]],
    [1, [0.9, 0.9, 0.75, 0.9, 0]],
    [7, [0.95, 0, 0.8, 0.9, 0.9]],
    [20, [0.95, 0.9, 0.85, 0, 0.9]],
    [45, [0.97, 0.95, 0, 0.95, 0]],
  ] as [number, number[]][]) {
    clock = new RealDate("2026-03-02T18:00:00Z").getTime() + d * DAY;
    for (let i = 0; i < plan.length; i++) if (accs[i] > 0) await session(ids[i], plan[i].side, 3, accs[i]);
  }
  // v1 preferences as the Settings page wrote them
  localStorage.setItem("cot.v1.prefs", JSON.stringify({ learnHints: false, sound: true }));

  const snapshot = Object.fromEntries([...store.entries()].filter(([k]) => k.startsWith("cot.v1.")).sort());
  writeFileSync(OUT, JSON.stringify({ generatedBy: "scripts/progress/make-v1-fixture.ts", openings: Object.fromEntries(plan.map((p, i) => [ids[i], p])), localStorage: snapshot }, null, 1) + "\n");
  const cards = JSON.parse(snapshot["cot.v1.cards"]);
  console.log(`wrote ${OUT}: ${Object.keys(cards).length} cards, ${JSON.parse(snapshot["cot.v1.attempts"]).length} attempts`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
