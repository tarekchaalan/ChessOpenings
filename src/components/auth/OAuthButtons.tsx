"use client";
/**
 * "Continue with Lichess / Chess.com" on /auth (ADR 0009). Plain links: the
 * start route redirects to the provider, and the callback lands on `next`
 * signed in. Renders nothing when no provider is configured.
 */
import { LogIn } from "lucide-react";
import { PLATFORM_NAME, PLATFORMS } from "@/lib/insights/types";
import { oauthEnabled, oauthStartUrl } from "@/lib/oauth/providers";

export default function OAuthButtons({ next }: { next: string }) {
  const providers = PLATFORMS.filter(oauthEnabled);
  if (!providers.length) return null;
  return (
    <div className="mb-5">
      <div className="space-y-2">
        {providers.map((p) => (
          <a
            key={p}
            href={oauthStartUrl(p, "signin", next)}
            className="w-full h-10 rounded-lg border border-edge bg-surface text-sm font-medium hover:bg-surface-2 flex items-center justify-center gap-2"
            data-testid={`auth-oauth-${p}`}
          >
            <LogIn size={15} aria-hidden />
            Continue with {PLATFORM_NAME[p]}
          </a>
        ))}
      </div>
      <div className="flex items-center gap-3 mt-5 text-xs text-muted" aria-hidden>
        <span className="h-px flex-1 bg-edge" />
        or use email
        <span className="h-px flex-1 bg-edge" />
      </div>
    </div>
  );
}
