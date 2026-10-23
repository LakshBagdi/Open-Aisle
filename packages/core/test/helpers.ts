/**
 * Shared test set-up: a clean database, a fake PayPal, one store, one shopper.
 */
import { sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { paypalVault, products, stores, users, type ProductImage } from "../src/db/schema";
import { resetEnv } from "../src/env";
import { createFakePayPal } from "../src/paypal/fake/fakePayPal";
import { resetPayPal } from "../src/paypal";
import { resetSigningKeys, setSpendingRules } from "../src/rules";
import { createPaymentToken, createSetupToken } from "../src/paypal";

export async function resetDb() {
  await getDb().execute(sql`
    truncate table notifications, refunds, orders, confirmation_tokens, carts, barriers, products,
      stores, messages, conversations, paypal_vault, spending_rules, users, webhook_events, ai_runs, eval_runs, merchant_api_keys
    restart identity cascade`);
}

export async function startFakePayPal(webhookUrl?: string) {
  const fake = createFakePayPal({ webhookUrl, webhookId: "TEST-WEBHOOK-ID", webhookDelayMs: 5 });
  process.env.PAYPAL_API_BASE = await fake.start();
  resetEnv();
  resetPayPal();
  resetSigningKeys();
  return fake;
}

export async function seedWorld(fake: ReturnType<typeof createFakePayPal>, opts: { perOrderCents?: number; monthlyCents?: number; connectPayPal?: boolean } = {}) {
  const db = getDb();
  const [store] = await db
    .insert(stores)
    .values({ slug: "northwind", name: "Northwind Outfitters", returnPolicy: "Free returns within 30 days.", taxRateBasisPoints: 825, deliveryCents: 599, freeDeliveryOverCents: 5000, deliveryDays: 3 })
    .returning();
  const img = (alt: string): ProductImage[] => [{ url: "https://example.com/shoe.jpg", alt }];
  const [shoe] = await db
    .insert(products)
    .values({
      storeId: store!.id,
      sku: "NW-TRAIL-01",
      category: "shoes",
      title: "Trail Runner 2",
      brand: "Northwind",
      priceCents: 5499,
      attributes: { material: "Recycled mesh upper, rubber sole", color: "Black", fit: "True to size", weight: "260 g" },
      options: { size: ["8", "9", "10", "11"] },
      images: img("Black running shoe with a white sole, seen from the side"),
      sizeChart: "US 9 = 27 cm foot length",
    })
    .returning();
  const [mug] = await db
    .insert(products)
    .values({ storeId: store!.id, sku: "NW-MUG-01", category: "kitchen", title: "Stoneware Mug", priceCents: 1499, attributes: { material: "Stoneware", capacity: "350 ml" }, images: img("") })
    .returning();
  const [user] = await db.insert(users).values({ displayName: "Asha" }).returning();
  await setSpendingRules(user!.id, { perOrderCents: opts.perOrderCents ?? 10_000, monthlyCents: opts.monthlyCents ?? 30_000, allowedStoreIds: [], undoWindowSeconds: 600 });

  if (opts.connectPayPal !== false) {
    const st = await createSetupToken({ returnUrl: "http://t/r", cancelUrl: "http://t/c", requestId: crypto.randomUUID() });
    fake.approve(st.setupTokenId);
    const pt = await createPaymentToken(st.setupTokenId, crypto.randomUUID());
    await db.insert(paypalVault).values({ userId: user!.id, setupTokenId: st.setupTokenId, paymentTokenId: pt.paymentTokenId, payerEmail: pt.payerEmail, status: "active" });
  }
  return { store: store!, shoe: shoe!, mug: mug!, user: user! };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
