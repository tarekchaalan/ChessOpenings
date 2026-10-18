import { chromium, type FullConfig } from "@playwright/test";
import { backupData } from "./fixtures";

/** Every route the live specs open: compiled once here, so no spec times a cold compile. */
const ROUTES = [
  "/explore?line=e4,e5,Nf3,Nc6,Bb5,a6,Ba4,Nf6,O-O,Be7,Re1,b5,Bb3,d6,c3,O-O,h3,Kh8",
  "/openings/ruy-lopez?stay=1",
  "/openings/ruy-lopez/closed/white",
  "/changes",
];
// Turbopack keeps compiling and writing its filesystem cache for a while after
// the first visits; a rebuild started then is starved of CPU
const SETTLE_MS = 15_000;

export default async function globalSetup(config: FullConfig) {
  backupData();
  // the webServer is already up when global setup runs
  const { baseURL, launchOptions } = config.projects[0].use;
  const browser = await chromium.launch(launchOptions);
  try {
    const page = await browser.newPage({ baseURL });
    for (const r of ROUTES) {
      await page.goto(r, { timeout: 180_000 });
      await page.waitForSelector("main, h1", { timeout: 180_000 }).catch(() => {});
    }
  } finally {
    await browser.close();
  }
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}
