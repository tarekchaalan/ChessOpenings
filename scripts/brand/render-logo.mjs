/**
 * Renders the logo PNGs from src/app/icon.svg (the one source of the drawing),
 * with Playwright's Chromium:
 *   src/app/apple-icon.png      180 px, full bleed (iOS rounds the corners itself)
 *   public/brand/logo-96.png     96 px, rounded, transparent corners (auth emails)
 *   docs/logo.png               256 px, rounded, transparent corners (README)
 *
 *   node scripts/brand/render-logo.mjs
 */
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("src/app/icon.svg", "utf8");
const OUT = [
  { path: "src/app/apple-icon.png", size: 180, fullBleed: true },
  { path: "public/brand/logo-96.png", size: 96 },
  { path: "docs/logo.png", size: 256 },
];

const browser = await chromium.launch();
try {
  for (const o of OUT) {
    const drawing = (o.fullBleed ? svg.replace('rx="14"', 'rx="0"') : svg).replace("<svg ", `<svg width="${o.size}" height="${o.size}" `);
    const page = await browser.newPage({ viewport: { width: o.size, height: o.size } });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">${drawing}</body></html>`);
    await page.locator("svg").screenshot({ path: o.path, omitBackground: !o.fullBleed });
    await page.close();
    console.log(`${o.path} (${o.size}px)`);
  }
} finally {
  await browser.close();
}
