/**
 * Client-side mirror of the project's Supabase password policy:
 * minimum 8 characters with lowercase, uppercase, digit and symbol.
 * The server (GoTrue) remains authoritative — this exists for instant,
 * friendly feedback before submission.
 */

export interface PasswordCheck {
  ok: boolean;
  label: string;
}

export function passwordChecks(pw: string): PasswordCheck[] {
  return [
    { ok: pw.length >= 8, label: "8+ characters" },
    { ok: /[a-z]/.test(pw), label: "lowercase" },
    { ok: /[A-Z]/.test(pw), label: "uppercase" },
    { ok: /[0-9]/.test(pw), label: "digit" },
    { ok: /[^A-Za-z0-9]/.test(pw), label: "symbol" },
  ];
}

export function passwordValid(pw: string): boolean {
  return passwordChecks(pw).every((c) => c.ok);
}

export const PASSWORD_POLICY_TEXT =
  "At least 8 characters, with a lowercase letter, an uppercase letter, a digit, and a symbol.";
