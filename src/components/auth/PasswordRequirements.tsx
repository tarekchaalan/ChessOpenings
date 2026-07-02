"use client";
/** Live indicator for the project's password policy (8+ chars, all character classes). */
import { Check, Dot } from "lucide-react";
import { passwordChecks } from "@/lib/password";

export default function PasswordRequirements({ password }: { password: string }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 px-1">
      {passwordChecks(password).map((c) => (
        <span
          key={c.label}
          className={`inline-flex items-center gap-0.5 text-xs transition-colors ${
            c.ok ? "text-accent" : "text-muted"
          }`}
        >
          {c.ok ? <Check size={11} strokeWidth={3} /> : <Dot size={11} />}
          {c.label}
        </span>
      ))}
    </div>
  );
}
