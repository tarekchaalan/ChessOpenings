import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { base32, lineIdFor, rowIdFor, sha256, sha256Hex, toHex } from "../hash";

describe("sha256 (pure TS)", () => {
  it("matches NIST vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("matches node:crypto on unicode and multi-block input", () => {
    for (const s of ["Grünfeld Defense: Exchange Variation", "x".repeat(1000), "a\tb\nc".repeat(77)]) {
      expect(toHex(sha256(s))).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });
});

describe("base32 / ids", () => {
  it("encodes RFC 4648 vectors (lower-case, unpadded)", () => {
    const enc = (s: string) => base32(new TextEncoder().encode(s));
    expect(enc("f")).toBe("my");
    expect(enc("fo")).toBe("mzxq");
    expect(enc("foobar")).toBe("mzxw6ytboi");
  });
  it("row ids are deterministic, 15 chars, and order-sensitive", () => {
    const a = rowIdFor(["e4", "e5", "Nf3"]);
    expect(a).toMatch(/^rw_[a-z2-7]{12}$/);
    expect(rowIdFor(["e4", "e5", "Nf3"])).toBe(a);
    expect(rowIdFor(["e4", "Nf3", "e5"])).not.toBe(a);
  });
  it("line ids depend on the course", () => {
    expect(lineIdFor("ruy-lopez/main@white", ["e4"])).not.toBe(lineIdFor("italian-game/main@white", ["e4"]));
  });
});

describe("injected hasher", () => {
  it("node:crypto and the pure implementation agree (so builds are identical in both)", () => {
    const s = JSON.stringify({ x: "é".repeat(5000) });
    expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
  });
});
