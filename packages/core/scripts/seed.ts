/**
 * Fill the database with demo stores, products and one demo shopper.
 * Safe to run again: it wipes the demo stores first.
 *
 *   pnpm db:seed              start the demo over
 *   pnpm db:seed --if-empty   only if there's no demo data yet
 */
import "../src/loadEnv";
import { eq, inArray } from "drizzle-orm";
import { scanStoreBarriers } from "../src/barriers";
import { closeDb, getDb } from "../src/db";
import { carts, notifications, orders, products, refunds, stores, users } from "../src/db/schema";
import { createApiKey } from "../src/merchant";
import { setSpendingRules } from "../src/rules";
import { SEED_STORES } from "./seed-data";

export const DEMO_USER_ID = "00000000-0000-4000-8000-00000000a5a0";

/**
 * Demo Merchant API keys, one per store. They only work against this demo
 * database (sandbox data), so it's fine for them to be in the README.
 */
export const DEMO_API_KEYS: Record<string, string> = {
  northwind: "oa_demo_northwind_sandbox_key",
  "maple-home": "oa_demo_maple_home_sandbox_key",
};

export async function seed() {
  const db = getDb();
  // Remove the old demo stores and everything that points at them.
  const old = await db.select({ id: stores.id }).from(stores).where(inArray(stores.slug, SEED_STORES.map((s) => s.slug)));
  const oldIds = old.map((s) => s.id);
  if (oldIds.length) {
    const oldOrders = (await db.select({ id: orders.id }).from(orders).where(inArray(orders.storeId, oldIds))).map((o) => o.id);
    if (oldOrders.length) {
      await db.delete(refunds).where(inArray(refunds.orderId, oldOrders));
      await db.delete(notifications).where(inArray(notifications.orderId, oldOrders));
      await db.delete(orders).where(inArray(orders.id, oldOrders));
    }
    await db.delete(carts).where(inArray(carts.storeId, oldIds));
    await db.delete(stores).where(inArray(stores.id, oldIds));
  }

  const storeIds: string[] = [];
  for (const s of SEED_STORES) {
    const { products: list, ...storeFields } = s;
    const [store] = await db.insert(stores).values(storeFields).returning();
    storeIds.push(store!.id);
    await db.insert(products).values(
      list.map((p) => ({
        storeId: store!.id,
        sku: p.sku,
        category: p.category,
        title: p.title,
        brand: p.brand,
        description: p.description,
        priceCents: p.priceCents,
        attributes: p.attributes,
        options: p.options ?? {},
        images: [{ url: `/img/product/${p.sku}.svg`, alt: p.alt }],
        sizeChart: p.sizeChart ?? null,
        returnPolicy: p.returnPolicy ?? null,
      })),
    );
    const n = await scanStoreBarriers(store!.id);
    const key = DEMO_API_KEYS[s.slug];
    if (key) await createApiKey(store!.id, "demo", key);
    console.log(`${store!.name}: ${list.length} products, ${n} barriers found${key ? `, Merchant API key ${key}` : ""}`);
  }

  // The demo shopper. A fixed id so the web app can sign in as her in demo mode.
  const [existing] = await db.select().from(users).where(eq(users.id, DEMO_USER_ID)).limit(1);
  if (!existing) await db.insert(users).values({ id: DEMO_USER_ID, displayName: "Asha", email: "asha.buyer@example.com" });
  await setSpendingRules(DEMO_USER_ID, { perOrderCents: 15_000, monthlyCents: 40_000, allowedStoreIds: storeIds, undoWindowSeconds: 600 });
  console.log("Demo shopper: Asha (limit $150 per order, $400 a month, 10-minute undo window)");
}

/** `pnpm db:seed --if-empty` only fills an empty database (used by `pnpm demo`, so restarting keeps your orders). */
async function main() {
  if (process.argv.includes("--if-empty")) {
    const [any] = await getDb().select({ id: stores.id }).from(stores).where(inArray(stores.slug, SEED_STORES.map((s) => s.slug))).limit(1);
    if (any) {
      console.log("Demo data is already there (your orders are kept). To start over: pnpm db:seed");
      return;
    }
  }
  await seed();
  console.log("SEEDED");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
