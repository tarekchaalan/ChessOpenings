/** §4.9 guest migration runner: backup first, idempotent, v1 keys removed, clearLocalData spares the backup. */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDatasetV2 } from "@/lib/openings";
import type { RawDatasetV2 } from "@/lib/openings-build/dataset";
import type { LegacyMap } from "@/lib/openings-build/legacy";

const root = join(__dirname, "../../../..");
const ds = parseDatasetV2(JSON.parse(readFileSync(join(root, "public/data/openings.v2.json"), "utf8")) as RawDatasetV2, "test");
const legacy = JSON.parse(readFileSync(join(root, "public/data/legacy-map.v1.json"), "utf8")) as LegacyMap;
const snap = (JSON.parse(readFileSync(join(__dirname, "fixtures/v1-localStorage.json"), "utf8")) as { localStorage: Record<string, string> }).localStorage;

const store = new Map<string, string>();
let failOn: string | null = null;
const writes: string[] = [];
const ls = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (k === failOn) throw new Error("QuotaExceededError");
    writes.push(k);
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
};
const win = Object.assign(new EventTarget(), { localStorage: ls });
Object.assign(globalThis, { window: win, localStorage: ls, CustomEvent: globalThis.CustomEvent ?? class extends Event {} });
// Object.keys(localStorage) in clearLocalData: expose the stored keys as own properties
const keysProxy = new Proxy(ls, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }) });
Object.assign(globalThis, { localStorage: keysProxy });

const { runGuestMigration } = await import("../migrate-runner");
const { clearLocalData, getPrefs } = await import("@/lib/prefs");
const fetchLegacy = async () => legacy;

beforeEach(() => {
  store.clear();
  writes.length = 0;
  failOn = null;
  for (const [k, v] of Object.entries(snap)) store.set(k, v);
});

describe("guest migration runner", () => {
  it("writes the backup before any v2 key, then removes the live v1 keys", async () => {
    const report = await runGuestMigration(ds, fetchLegacy);
    expect(report?.dropped).toEqual([]);
    expect(writes[0]).toBe("cot.v1.backup");
    expect(writes.indexOf("cot.v2.migrated")).toBe(writes.length - 1);
    const backup = JSON.parse(store.get("cot.v1.backup")!);
    expect(backup[report!.hash].keys).toEqual(snap);
    for (const k of Object.keys(snap)) expect(store.has(k)).toBe(false);
    expect(Object.keys(JSON.parse(store.get("cot.v2.cards")!)).length).toBe(report!.v2Cards);
    expect(store.get("cot.v2.attempts")).toBe(snap["cot.v1.attempts"]);
    // prefs: v1 values kept, new fields defaulted
    expect(getPrefs()).toMatchObject({ learnHints: false, sound: true, dailyNewLines: 5, targetRetention: 0.9 });
  });
  it("is idempotent: a second run does nothing", async () => {
    await runGuestMigration(ds, fetchLegacy);
    const before = new Map(store);
    expect(await runGuestMigration(ds, fetchLegacy)).toBeNull();
    expect(new Map(store)).toEqual(before);
  });
  it("a crash after the marker but before removing v1 keys only finishes the removal", async () => {
    await runGuestMigration(ds, fetchLegacy);
    const cards = store.get("cot.v2.cards");
    for (const [k, v] of Object.entries(snap)) store.set(k, v); // v1 keys came back unchanged
    expect(await runGuestMigration(ds, fetchLegacy)).toBeNull();
    expect(store.get("cot.v2.cards")).toBe(cards);
    expect(store.has("cot.v1.cards")).toBe(false);
  });
  it("no backup, no migration: a failed backup write leaves everything as it was", async () => {
    failOn = "cot.v1.backup";
    expect(await runGuestMigration(ds, fetchLegacy)).toBeNull();
    expect([...store.keys()].sort()).toEqual(Object.keys(snap).sort());
  });
  it("a failed v2 write leaves no marker (the next load retries) and keeps v1 + backup", async () => {
    failOn = "cot.v2.courseProgress";
    expect(await runGuestMigration(ds, fetchLegacy)).toBeNull();
    expect(store.has("cot.v2.migrated")).toBe(false);
    expect(store.has("cot.v1.cards")).toBe(true);
    expect(store.has("cot.v1.backup")).toBe(true);
  });
  it("clearLocalData clears cot.v2.* but keeps the v1 backup", async () => {
    await runGuestMigration(ds, fetchLegacy);
    store.set("theme", "dark");
    clearLocalData();
    expect([...store.keys()].sort()).toEqual(["cot.v1.backup", "theme"]);
  });
  it("without v1 data nothing runs and the legacy map isn't fetched", async () => {
    store.clear();
    let fetched = false;
    expect(await runGuestMigration(ds, async () => ((fetched = true), legacy))).toBeNull();
    expect(fetched).toBe(false);
  });
});
