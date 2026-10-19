import { defineConfig, devices } from "@playwright/test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.E2E_PORT ?? 3100);
// Use a pre-installed Chromium when the environment provides one (no download):
// PLAYWRIGHT_CHROMIUM_PATH, else the newest chromium-* under PLAYWRIGHT_BROWSERS_PATH.
function systemChromium(): string | undefined {
  if (process.env.PLAYWRIGHT_CHROMIUM_PATH) return process.env.PLAYWRIGHT_CHROMIUM_PATH;
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!dir || !existsSync(dir)) return undefined;
  const builds = readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const b of builds) {
    const exe = join(dir, b, "chrome-linux", "chrome");
    if (existsSync(exe)) return exe;
  }
  return undefined;
}
const executablePath = systemChromium();

// e2e/supabase-stub.mjs: real migrations on a local Postgres behind a PostgREST/GoTrue
// subset, so signed-in specs (friends) exercise the real policies. Its anon key is an
// unsigned JWT the stub derives the same way.
export const SUPABASE_STUB_PORT = Number(process.env.E2E_SUPABASE_PORT ?? 54398);
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
const STUB_ANON_KEY = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role: "anon", iss: "supabase-stub", exp: 4102444800 })}.e2e`;

export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/supabase-stub.mjs",
      url: `http://127.0.0.1:${SUPABASE_STUB_PORT}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      // E2E_PROD=1: a production build (the perf budgets are measured there; dev React is several times slower)
      command: process.env.E2E_PROD ? `npm run build && npx next start -p ${PORT}` : `npm run dev -- -p ${PORT}`,
      url: `http://localhost:${PORT}/data/openings.v2.meta.json`,
      timeout: process.env.E2E_PROD ? 900_000 : 180_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        NEXT_PUBLIC_SUPABASE_URL: `http://127.0.0.1:${SUPABASE_STUB_PORT}`,
        NEXT_PUBLIC_SUPABASE_ANON_KEY: STUB_ANON_KEY,
      },
    },
  ],
});
