import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

async function openSample(page: Page, query = "") {
  await page.goto(`/?db=sensors.duckdb${query}`);
  await expect(page.getByRole("region", { name: "File summary" })).toContainText(/read by DuckDB-Wasm/);
}

test("shows the file facts and storage checks", async ({ page }) => {
  await openSample(page);
  await expect(page.getByText("420,000")).toBeVisible();
  await expect(page.getByText("44 × 256 KB", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sorted/ })).toContainText("main.sensors.event_id");
  await expect(page.getByRole("button", { name: /Compact/ })).not.toHaveClass(/passed/);
});

test("opens a row group from the file map and mirrors it in the URL", async ({ page, isMobile }) => {
  await openSample(page, "&table=main.sensors");
  const strip = page.getByLabel("File layout");
  const box = await strip.boundingBox();
  if (!box) throw new Error("no strip");
  const at = { x: box.width * 0.01, y: box.height / 2 };
  if (isMobile) await strip.tap({ position: at });
  else await strip.click({ position: at });
  await expect(page.locator("[aria-expanded=true]")).toHaveCount(1);
  await expect(page).toHaveURL(/rg=\d/);
});

test("selecting a column shows its per-row-group ranges", async ({ page }) => {
  await openSample(page);
  await page.getByRole("button", { name: /^Column main\.sensors\.event_id,/ }).click();
  await expect(page).toHaveURL(/col=event_id/);
  await expect(page.getByText("sorted: filters on it skip row groups")).toBeVisible();
  await page.getByTitle("Open row_group[2]").click();
  await expect(page).toHaveURL(/rg=2/);
  await expect(page.locator("[aria-expanded=true]")).toContainText("245,760–368,639");
});

test("switches tables and restores a shared link", async ({ page }) => {
  await openSample(page, "&table=logs.events&rg=0");
  await expect(page.getByRole("tab", { name: /logs\.events/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("[aria-expanded=true]")).toContainText("0–19,999");
  await page.getByRole("tab", { name: /main\.sensors/ }).click();
  await expect(page).toHaveURL(/table=main\.sensors/);
});

test("hovering the file map explains the block under the pointer", async ({ page, isMobile }) => {
  test.skip(isMobile, "no hover on touch screens");
  await openSample(page);
  const strip = page.getByLabel("File layout");
  const box = await strip.boundingBox();
  if (!box) throw new Error("no strip");
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height / 2);
  await expect(page.getByRole("tooltip")).toContainText("Free block");
});

test("reads a database by its path on this machine", async ({ page }) => {
  await page.goto(`/?db=${encodeURIComponent(path.resolve("public/sensors.duckdb"))}`);
  await expect(page.getByRole("region", { name: "File summary" })).toContainText("sensors.duckdb");
});

test("reports files that aren't DuckDB databases", async ({ page }) => {
  await page.goto("/?db=index.html");
  await expect(page.getByRole("status")).toContainText("doesn't look like a DuckDB database");
});

test("lists the write-ahead log and greys out the torn last commit", async ({ page }) => {
  await page.goto("/?db=orders.duckdb");
  const wal = page.getByRole("region", { name: "Write-ahead log" });
  await expect(wal).toContainText("11 commits");
  await expect(wal).toContainText("2 incomplete");
  await expect(wal.locator("button.row.incomplete")).toHaveCount(2);
  await expect(wal.locator("button.row.incomplete").last()).toContainText("incomplete");
  await expect(page.getByRole("button", { name: /Checkpointed/ })).not.toHaveClass(/passed/);
});

test("shows what a WAL entry holds when clicked", async ({ page }) => {
  await page.goto("/?db=orders.duckdb");
  const wal = page.getByRole("region", { name: "Write-ahead log" });
  await wal.locator("button.row", { hasText: "INSERT 2 rows into shop.orders" }).click();
  await expect(wal.getByRole("table")).toContainText("12.50");
  await expect(wal.getByRole("table")).toContainText("{'city': 'Oslo', 'express': true}");
  await wal.locator("button.row", { hasText: "INSERT 500 rows" }).click();
  await expect(wal).toContainText("truncated: the entry is");
  await expect(wal).toContainText("500 rows, but their values are cut off");
});

test("pairs a picked database with its .wal", async ({ page }) => {
  await page.goto("/");
  await page
    .locator("input[type=file]")
    .first()
    .setInputFiles([path.resolve("public/orders.duckdb"), path.resolve("public/orders.duckdb.wal")]);
  await expect(page.getByRole("region", { name: "Write-ahead log" })).toContainText("2 incomplete");
});

test("opens a .wal for a database picked on its own", async ({ page }) => {
  await page.goto("/");
  await page.locator("input[type=file]").first().setInputFiles(path.resolve("public/orders.duckdb"));
  const wal = page.getByRole("region", { name: "Write-ahead log" });
  await expect(wal).toContainText("can't see the .wal next to it");
  await wal.locator("input[type=file]").setInputFiles(path.resolve("public/orders.duckdb.wal"));
  await expect(wal).toContainText("11 commits");
});
