"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { Moon, Sun, User as UserIcon, LogOut, Menu, X, Settings } from "lucide-react";
import Logo from "@/components/Logo";
import { useAuth } from "@/lib/supabase/AuthProvider";

const NAV = [
  { href: "/", label: "Dashboard" },
  { href: "/explore", label: "Explore" },
  { href: "/learn", label: "Learn" },
  { href: "/quiz", label: "Quiz" },
  { href: "/leaderboard", label: "Leaderboard" },
];

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

  useEffect(() => setOpen(false), [pathname]);

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-background/90 backdrop-blur">
      <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-2">
        <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight mr-4">
          <span className="w-7 h-7 grid place-items-center rounded-md bg-accent text-accent-fg">
            <Logo size={20} />
          </span>
          <span className="hidden sm:inline">Openings Trainer</span>
        </Link>

        <nav className="hidden md:flex items-center gap-1 text-sm">
          {NAV.map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
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
                {n.label}
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
          {[...NAV, { href: "/settings", label: "Settings" }].map((n) => {
            const active = n.href === "/" ? pathname === "/" : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`px-3 py-2.5 rounded-md text-sm ${
                  active ? "bg-accent-soft text-accent font-medium" : "text-muted"
                }`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      )}
    </header>
  );
}
