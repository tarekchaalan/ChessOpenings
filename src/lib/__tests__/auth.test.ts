import { describe, expect, it } from "vitest";
import { authErrorMessage, callbackErrorMessage, callbackUrl, safeNext } from "../auth";

describe("safeNext", () => {
  it("keeps same-origin paths", () => {
    expect(safeNext("/settings")).toBe("/settings");
    expect(safeNext("/train/a/b/white?x=1#y")).toBe("/train/a/b/white?x=1#y");
  });
  it("rejects anything that could leave the origin", () => {
    for (const bad of ["//evil.com", "/\\evil.com", "@evil.com", "https://evil.com", "evil.com", "/a\\b", "/\tx"]) {
      expect(safeNext(bad), bad).toBe("/");
    }
  });
  it("falls back when missing", () => {
    expect(safeNext(null)).toBe("/");
    expect(safeNext("", "/auth/reset")).toBe("/auth/reset");
  });
});

describe("callbackUrl", () => {
  it("encodes a safe next", () => {
    expect(callbackUrl("https://x.app", "/auth/reset")).toBe("https://x.app/auth/callback?next=%2Fauth%2Freset");
    expect(callbackUrl("https://x.app", "//evil.com")).toBe("https://x.app/auth/callback?next=%2F");
  });
});

describe("authErrorMessage", () => {
  it("maps Supabase error codes", () => {
    expect(authErrorMessage({ code: "invalid_credentials", message: "Invalid login credentials" })).toBe("Wrong email or password.");
    expect(authErrorMessage({ code: "23505", message: "duplicate key" })).toBe("That username is taken.");
    expect(authErrorMessage({ code: "email_address_not_authorized", message: "x" })).toMatch(/can't send email/);
  });
  it("recognises rate limits by status or message", () => {
    expect(authErrorMessage({ status: 429, message: "x" })).toMatch(/Too many/);
    expect(authErrorMessage({ message: "For security purposes, you can only request this after 42 seconds." })).toMatch(/Too many/);
  });
  it("passes other messages through", () => {
    expect(authErrorMessage(new Error("Usernames are short"))).toBe("Usernames are short");
    expect(authErrorMessage(undefined)).toMatch(/Something went wrong/);
  });
});

describe("callbackErrorMessage", () => {
  it("explains expired and cross-browser links", () => {
    expect(callbackErrorMessage("otp_expired")).toMatch(/expired/);
    expect(callbackErrorMessage("flow_state_not_found")).toMatch(/different browser/);
    expect(callbackErrorMessage("pkce_code_verifier_not_found")).toMatch(/different browser/);
    expect(callbackErrorMessage("whatever")).toMatch(/Sign-in failed/);
    expect(callbackErrorMessage(null)).toBeNull();
  });
});
