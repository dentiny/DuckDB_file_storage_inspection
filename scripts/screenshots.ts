/**
 * Regenerates the README screenshots in docs/ from the production build.
 * Run with `npm run screenshots` (it builds and serves the app itself).
 */
import { chromium, type Locator, type Page } from "@playwright/test";
import { spawn } from "node:child_process";

const PORT = 4174;
const BASE = `http://localhost:${PORT}`;

async function open(page: Page, query: string) {
  await page.goto(`${BASE}/?${query}`);
  await page.getByRole("region", { name: "File summary" }).waitFor({ timeout: 90_000 });
  await page.waitForTimeout(300);
}

async function hoverStrip(page: Page, label: string, at: number) {
  const box = await page.getByLabel(label).boundingBox();
  if (!box) throw new Error(`no ${label}`);
  await page.mouse.move(box.x + box.width * at, box.y + box.height / 2);
  await page.getByRole("tooltip").waitFor();
}

/** A screenshot spanning `from`'s top to `to`'s bottom, with a little margin. */
async function shoot(page: Page, from: Locator, to: Locator, path: string) {
  await to.scrollIntoViewIfNeeded();
  const top = await from.boundingBox();
  const bottom = await to.boundingBox();
  if (!top || !bottom) throw new Error(`nothing to shoot for ${path}`);
  const margin = 8;
  await page.screenshot({
    path,
    clip: {
      x: top.x - margin,
      y: top.y - margin,
      width: top.width + 2 * margin,
      height: bottom.y + bottom.height - top.y + 2 * margin,
    },
  });
}

// Its own process group, so stopping it also stops the vite process npx starts.
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  stdio: "ignore",
  detached: true,
});
await new Promise((resolve) => setTimeout(resolve, 1500));
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });

  await open(page, "db=sensors.duckdb&table=main.sensors&rg=1");
  await hoverStrip(page, "File layout", 0.03);
  await page.screenshot({ path: "docs/overview.png" });

  // The file map and the allocation card, with the active header's slot outlined in the magnified headers.
  await page.mouse.move(0, 0);
  const allocation = page.getByRole("region", { name: "Block allocation" });
  await allocation.locator(".header.active .title").hover();
  await page.waitForTimeout(200);
  await shoot(page, page.locator("section.card").first(), allocation, "docs/allocation.png");

  // A WAL whose last commit was cut off, with its torn INSERT opened.
  await open(page, "db=orders.duckdb");
  const wal = page.getByRole("region", { name: "Write-ahead log" });
  await wal.locator("button.row", { hasText: "INSERT 600 rows" }).click();
  await page.waitForTimeout(300);
  await shoot(page, wal, wal, "docs/wal.png");

  await wal.locator("button.row", { hasText: "INSERT 2 rows into shop.orders" }).click();
  await page.waitForTimeout(300);
  const detail = wal.locator(".detail");
  await shoot(
    page,
    wal.locator("button.row", { hasText: "INSERT 2 rows into shop.orders" }),
    detail,
    "docs/wal-entry.png",
  );
} finally {
  await browser.close();
  if (server.pid) process.kill(-server.pid);
}
