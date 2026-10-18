import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";
import { AuthProvider } from "@/lib/supabase/AuthProvider";
import Header from "@/components/Header";
import DataUpdateToast from "@/components/DataUpdateToast";
import ProgressMaintenance from "@/components/ProgressMaintenance";
import ServerSync from "@/components/ServerSync";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Chess Openings Trainer",
    template: "%s · Chess Openings Trainer",
  },
  description:
    "Learn every chess opening by name, drill mainlines and variations against real theory, and climb the leaderboard.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* suppressHydrationWarning: browser extensions (ColorZilla, Grammarly…)
          inject attributes into <body> before React hydrates */}
      <body className="min-h-screen flex flex-col" suppressHydrationWarning>
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <AuthProvider>
            <Header />
            <main className="flex-1 w-full max-w-6xl mx-auto px-4 pb-16">{children}</main>
            <DataUpdateToast />
            <ProgressMaintenance />
            <ServerSync />
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
