"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Moon, Sun, User as UserIcon, LogOut, Menu, X, Settings } from "lucide-react";
import Logo from "@/components/Logo";
import { useAuth } from "@/lib/supabase/AuthProvider";
import { useNotificationCount } from "@/lib/friends/api";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/openings", label: "Openings" },
  { href: "/explore", label: "Explore" },
  { href: "/insights", label: "Insights" },
  { href: "/friends", label: "Friends", account: true },
  { href: "/leaderboard", label: "Leaderboard" },
];

/** "Friends" plus the unread badge (new followers, requests, accepted requests). */
function NavLabel({ label, badge }: { label: string; badge: number }) {
  if (!badge) return <>{label}</>;
  return (
    <span className="inline-flex items-center gap-1.5">
      {label}
      <span aria-hidden className="min-w-5 h-5 px-1 rounded-full bg-accent text-accent-fg text-[11px] leading-5 text-center font-semibold" data-testid="friends-badge-count">
        {badge > 9 ? "9+" : badge}
      </span>
      <span className="sr-only">, {badge} new</span>
    </span>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="w-9 h-9" />;
  return (
    <button
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="w-9 h-9 grid place-items-center rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
    >
      {resolvedTheme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}

export default function Header() {
  const pathname = usePathname();
  const { user, username, configured, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const badge = useNotificationCount(configured && !!user);
  // Friends only for signed-in players on a deployment with accounts
  const nav = NAV.filter((n) => !n.account || (configured && user));

  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/90 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight mr-4">
          <Logo size={40} className="shrink-0" />
          <span className="hidden sm:inline">Openings Trainer</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1 text-sm">
          {nav.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href) || (n.href === "/openings" && pathname.startsWith("/train"));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-1.5 rounded-md transition-colors ${
                  active
                    ? "bg-accent-soft text-accent font-medium"
                    : "text-muted hover:text-foreground hover:bg-surface-2"
                }`}
              >
                <NavLabel label={n.label} badge={n.href === "/friends" ? badge : 0} />
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />
        <Link
          href="/settings"
          aria-label="Settings"
          className={`w-9 h-9 grid place-items-center rounded-md transition-colors ${
            pathname.startsWith("/settings")
              ? "bg-accent-soft text-accent"
              : "text-muted hover:text-foreground hover:bg-surface-2"
          }`}
        >
          <Settings size={17} />
        </Link>
        <ThemeToggle />

        {configured ? (
          user ? (
            <div className="flex items-center gap-1">
              <span className="hidden sm:block text-sm text-muted px-2 max-w-36 truncate">
                {username ?? user.email}
              </span>
              <button
                aria-label="Sign out"
                onClick={() => signOut()}
                className="w-9 h-9 grid place-items-center rounded-md text-muted hover:text-foreground hover:bg-surface-2 transition-colors"
              >
                <LogOut size={17} />
              </button>
            </div>
          ) : (
            <Link
              href="/auth"
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md bg-accent text-accent-fg hover:opacity-90 transition-opacity font-medium"
            >
              <UserIcon size={15} /> Sign in
            </Link>
          )
        ) : (
          <span className="hidden lg:block text-xs text-muted px-2" title="Set NEXT_PUBLIC_SUPABASE_URL to enable accounts">
            guest mode
          </span>
        )}

        <button
          aria-label="Menu"
          className="md:hidden w-9 h-9 grid place-items-center rounded-md text-muted hover:text-foreground"
          onClick={() => setOpen(!open)}
        >
          {open ? <X size={18} /> : <Menu size={18} />}
        </button>
      </div>

      {open && (
        <nav className="md:hidden border-t border-edge px-4 py-2 flex flex-col bg-background">
          {[...nav, { href: "/settings", label: "Settings" }].map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href) || (n.href === "/openings" && pathname.startsWith("/train"));
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-2.5 rounded-md text-sm ${
                  active ? "bg-accent-soft text-accent font-medium" : "text-muted"
                }`}
              >
                <NavLabel label={n.label} badge={n.href === "/friends" ? badge : 0} />
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
