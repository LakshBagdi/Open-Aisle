/**
 * Real-browser checks for Open Aisle.
 *
 *   pnpm fake-paypal          (terminal 1)
 *   pnpm build && pnpm --filter @open-aisle/web start   (terminal 2, or pnpm dev)
 *   pnpm e2e                  (terminal 3)
 *
 * Needs a Chromium: `npx playwright install chromium`, or set CHROME_PATH.
 * Uses the same database as the app (DATABASE_URL in the root .env). For a
 * clean run, reset the demo data first with `pnpm db:seed`.
 *
 * Only /api/chat is stubbed (so no Anthropic key is needed): the stub returns
 * a read-back event for a REAL cart, and everything after that (confirm, PayPal
 * hold, undo, cancel) runs for real against the fake PayPal.
 */
import "@open-aisle/core/load-env";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import { AxeBuilder } from "@axe-core/playwright";
import { and, eq } from "drizzle-orm";
import { chromium, type Page } from "playwright";
import { closeDb, getDb } from "@open-aisle/core";
import { addToCart } from "@open-aisle/core/cart";
import { carts, paypalVault, products, stores, users } from "@open-aisle/core/db/schema";
import { buildReadBack } from "@open-aisle/core/orders";
import { cartFingerprint } from "@open-aisle/core/rules";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const PAYPAL = process.env.PAYPAL_API_BASE ?? "http://127.0.0.1:4010";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "screenshots");
const USER = "00000000-0000-4000-8000-00000000a5a0";
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}`);
  if (!ok) failures++;
}

async function axe(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
  check(r.violations.length === 0, `${label}: no WCAG 2.2 AA violations${r.violations.length ? ` (found ${r.violations.map((v) => v.id).join(", ")})` : ""}`);
}

/** Like the agent would: put the demo shoe in Asha's cart and build the read-back event. */
async function prepareCart() {
  const db = getDb();
  await db.update(carts).set({ status: "abandoned" }).where(and(eq(carts.userId, USER), eq(carts.status, "open")));
  await db.update(paypalVault).set({ status: "removed" }).where(eq(paypalVault.userId, USER));
  const [p] = await db.select().from(products).where(eq(products.sku, "NW-TRAIL-RUNNER-2"));
  if (!p) throw new Error("Run pnpm db:seed first.");
  const cart = await addToCart(USER, p.id, { size: "9" });
  const [s] = await db.select().from(stores).where(eq(stores.id, cart.storeId));
  const rb = buildReadBack(cart, s!, 600);
  return { type: "readback", cartId: cart.id, fingerprint: cartFingerprint(cart), storeName: rb.storeName, lines: rb.lines, totalLine: rb.totalLine, deliveryLine: rb.deliveryLine, undoLine: rb.undoLine, spoken: rb.spoken };
}

async function main() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Start as a first-time visitor.
  const [asha] = await getDb().select().from(users).where(eq(users.id, USER));
  await getDb().update(users).set({ modes: { ...asha!.modes, onboarded: false, voice: false, handsFree: false } }).where(eq(users.id, USER));

  console.log("First visit: choosing how to use Open Aisle");
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const chooser = page.getByRole("heading", { name: "How would you like to use Open Aisle?" });
  check(await chooser.isVisible(), "a first-time visitor is asked how they want to use it (voice, screen reader, or type)");
  await axe(page, "/ with the first-visit question");
  await page.getByRole("button", { name: /Read and type/ }).click();
  await page.waitForTimeout(500);
  await page.reload({ waitUntil: "networkidle" });
  check(!(await chooser.isVisible()), "the choice is remembered");
  check(await page.getByRole("checkbox", { name: "Read replies aloud" }).isVisible(), "spoken replies can be switched on right next to the message box");

  console.log("Accessibility");
  for (const path of ["/", "/orders", "/settings", "/merchant", "/merchant/board", "/merchant/insights", "/merchant/developers"]) {
    await page.goto(BASE + path, { waitUntil: "networkidle" });
    await page.waitForTimeout(path.includes("board") || path.includes("insights") ? 3000 : 300);
    await axe(page, path);
  }

  console.log("Shopper: connect PayPal, hear the read-back, confirm, undo");
  const rb = await prepareCart();
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect PayPal" }).click();
  await page.waitForURL(/fake\/approve/);
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await page.waitForURL(/settings\?paypal=connected/);
  check(((await page.getByRole("status").first().textContent()) ?? "").includes("connected"), "PayPal connected through the approval page");

  await page.route("**/api/chat", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    await route.fulfill({
      json: { ok: true, conversationId: crypto.randomUUID(), reply: "I found the Trail Runner 2 for $54.99. I'm reading your order back now.", events: [rb], grounding: { passed: true, problems: [] } },
    });
  });
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const box = page.getByLabel("Your message");
  await box.fill("Black running shoes, size 9, under 60 dollars. Buy them.");
  await box.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Check your order" });
  await dialog.waitFor();
  check((await page.evaluate(() => document.activeElement?.tagName)) === "DIALOG", "focus starts on the order, not the Confirm button");
  await axe(page, "read-back dialog");
  await page.keyboard.press("Tab");
  check(((await page.evaluate(() => document.activeElement?.textContent)) ?? "").includes("Confirm and pay $59.53"), "first Tab reaches “Confirm and pay $59.53”");
  await page.screenshot({ path: join(OUT, "1-readback.png") });
  await dialog.getByRole("button", { name: /Confirm and pay/ }).click();
  await page.getByRole("heading", { name: "You can still cancel" }).waitFor();
  check(true, "confirm placed a PayPal hold and opened the undo panel");
  await page.screenshot({ path: join(OUT, "2-held.png"), fullPage: true });
  await page.getByRole("button", { name: "Cancel this order" }).click();
  await page.getByText("Cancelled. Nothing was charged.").last().waitFor();
  const state = (await (await fetch(`${PAYPAL}/fake/state`)).json()) as { authorizations: { status: string; amount: { value: string } }[] };
  check(state.authorizations.some((a) => a.status === "VOIDED" && a.amount.value === "59.53"), "cancel voided the $59.53 hold at PayPal");
  await page.unroute("**/api/chat");

  console.log("Simple mode (no AI key): a whole purchase by typing, with nothing stubbed");
  await prepareCart(); // empties the cart (and disconnects PayPal, so connect again)
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect PayPal" }).click();
  await page.waitForURL(/fake\/approve/);
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await page.waitForURL(/settings\?paypal=connected/);
  await page.getByRole("checkbox", { name: /read replies aloud/i }).waitFor();
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  const ask = async (words: string) => {
    const reply = page.waitForResponse((r) => r.url().endsWith("/api/chat") && r.request().method() === "POST");
    await page.getByLabel("Your message").fill(words);
    await page.getByLabel("Your message").press("Enter");
    return (await (await reply).json()) as { ok: boolean; reply: string; mode: string };
  };
  // Start from an empty cart, whatever earlier runs left behind.
  await getDb().update(carts).set({ status: "abandoned" }).where(and(eq(carts.userId, USER), eq(carts.status, "open")));
  const first = await ask("trail running shoes under 60");
  if (first.mode !== "basic") {
    console.log("  (skipped: an AI key is set, so the app isn't in simple mode)");
  } else {
    check(first.reply.includes("Number 1: Trail Runner 2"), "search answers with numbered results from store data");
    check(await page.getByRole("heading", { name: "Simple mode" }).isVisible(), "the page explains simple mode and what to say");
    const added = await ask("add number 1, size 9");
    check(added.reply.includes("Added the Trail Runner 2, size 9"), "“add number 1, size 9” fills the cart");
    await ask("buy it");
    await page.getByRole("dialog", { name: "Check your order" }).waitFor();
    check(true, "“buy it” opens the read-back");
    // Typing "confirm" while the read-back is open presses Confirm (same as saying it).
    await page.keyboard.press("Tab");
    await page.getByRole("dialog").getByRole("button", { name: /Confirm and pay/ }).click();
    await page.getByRole("heading", { name: "You can still cancel" }).waitFor();
    await page.getByLabel("Your message").fill("cancel that");
    await page.getByLabel("Your message").press("Enter");
    await page.getByText("Cancelled. Nothing was charged.").last().waitFor();
    check(true, "“cancel that” cancels inside the undo window, without the AI");
    await page.screenshot({ path: join(OUT, "2b-simple-mode.png"), fullPage: true });
  }

  console.log("Store: fix board");
  await page.goto(`${BASE}/merchant/board`, { waitUntil: "networkidle" });
  await page.waitForSelector(".b-task-board-card");
  const counts = () => page.$$eval(".b-task-board-column-header", (els) => els.map((e) => (e as HTMLElement).innerText.replace(/\s+/g, " ")));
  const before = await counts();
  const card = page.locator(".b-task-board-card").first();
  const target = page.locator(".b-task-board-column").nth(1);
  const cb = (await card.boundingBox())!;
  const tb = (await target.boundingBox())!;
  await page.mouse.move(cb.x + cb.width / 2, cb.y + 20);
  await page.mouse.down();
  await page.mouse.move(cb.x + cb.width / 2 + 40, cb.y + 40, { steps: 5 });
  await page.mouse.move(tb.x + tb.width / 2, tb.y + 120, { steps: 15 });
  await page.mouse.up();
  await page.getByText(/moved to Being fixed/).waitFor();
  const after = await counts();
  check(before.join() !== after.join(), `dragging a card moves it (${after.join(" / ")})`);
  await page.locator(".b-task-board-card").first().click();
  check((await page.evaluate(() => document.activeElement?.id)) === "fix-title", "choosing a card opens the fix form with focus on its heading");
  await page.screenshot({ path: join(OUT, "3-board.png"), fullPage: true });

  console.log("Store: insights");
  await page.goto(`${BASE}/merchant/insights`, { waitUntil: "networkidle" });
  await page.getByText("What shoppers needed but didn't get").waitFor({ timeout: 15_000 });
  check(true, "AG Studio dashboard renders its charts");
  await page.screenshot({ path: join(OUT, "4-insights.png"), fullPage: true });

  console.log("Outside agent: confirm link");
  const rb2 = await prepareCart();
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Connect PayPal" }).click();
  await page.waitForURL(/fake\/approve/);
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await page.waitForURL(/settings\?paypal=connected/);
  await page.goto(`${BASE}/confirm/${rb2.cartId}?fp=${"0".repeat(64)}`, { waitUntil: "networkidle" });
  check((await page.locator("h1").innerText()) === "This order changed", "a link with the wrong fingerprint can't be used");
  await page.goto(`${BASE}/confirm/${rb2.cartId}?fp=${rb2.fingerprint}`, { waitUntil: "networkidle" });
  await axe(page, "/confirm");
  await page.getByRole("button", { name: /Confirm and pay/ }).click();
  await page.locator("#placed-title").waitFor();
  check((await page.locator("#placed-title").innerText()) === "Order placed", "confirming on Open Aisle's page places the hold");
  await page.getByRole("button", { name: /Cancel this order/ }).click();
  await page.getByText("Cancelled. Nothing was charged.").waitFor();
  check(true, "and it can be undone");

  await browser.close();
  console.log(failures === 0 ? "\nAll browser checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
