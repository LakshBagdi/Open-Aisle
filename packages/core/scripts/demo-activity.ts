/**
 * Simulated shoppers, so the store pages (barrier report, fix board, insights)
 * have something to show in a demo.
 *
 * Nothing here is faked at the database level: every order goes through the
 * real code path (cart → confirmation token → signed limits → PayPal hold →
 * cancel or capture), and every barrier hit is recorded the same way the agent
 * records one. Only the shoppers are pretend.
 *
 *   pnpm demo:activity          (needs `pnpm fake-paypal` running, or a sandbox
 *                                account connected in Settings)
 */
import "../src/loadEnv";
import { and, eq } from "drizzle-orm";
import { recordBarrierHits } from "../src/barriers";
import { addToCart } from "../src/cart";
import { closeDb, getDb } from "../src/db";
import { paypalVault, products, stores, users } from "../src/db/schema";
import { env } from "../src/env";
import { cancelOrder, captureDueOrders, placeOrder } from "../src/orders";
import { createPaymentToken, createSetupToken } from "../src/paypal";
import { issueConfirmation, setSpendingRules } from "../src/rules";
import { DEMO_USER_ID } from "./seed";

/** With the fake PayPal we can approve the saved account ourselves. */
async function ensurePayPal(userId: string) {
  const db = getDb();
  const base = env().PAYPAL_API_BASE;
  const [active] = await db.select().from(paypalVault).where(and(eq(paypalVault.userId, userId), eq(paypalVault.status, "active"))).limit(1);
  if (active && !base) return; // real sandbox: use what the person connected in Settings
  if (!base) throw new Error("Connect PayPal in Settings first (or run with the fake PayPal).");
  // The fake forgets saved accounts when it restarts, so always make a fresh one.
  const st = await createSetupToken({ returnUrl: "http://localhost/r", cancelUrl: "http://localhost/c", requestId: crypto.randomUUID() });
  await fetch(`${base}/fake/approve/${st.setupTokenId}?auto=1`, { redirect: "manual" });
  const pt = await createPaymentToken(st.setupTokenId, crypto.randomUUID());
  await db.update(paypalVault).set({ status: "removed" }).where(eq(paypalVault.userId, userId));
  await db.insert(paypalVault).values({ userId, setupTokenId: st.setupTokenId, paymentTokenId: pt.paymentTokenId, payerEmail: pt.payerEmail, status: "active" });
}

async function buy(userId: string, sku: string, variant: Record<string, string>, outcome: "capture" | "cancel" | "hold") {
  const [p] = await getDb().select().from(products).where(eq(products.sku, sku)).limit(1);
  if (!p) throw new Error(`No product ${sku}; run pnpm db:seed first.`);
  const [s] = await getDb().select().from(stores).where(eq(stores.id, p.storeId)).limit(1);
  await recordBarrierHits(p, s!); // the agent looked at it before buying
  const cart = await addToCart(userId, p.id, variant);
  const { token } = await issueConfirmation(userId, cart.id);
  const { order } = await placeOrder(userId, cart.id, token);
  if (outcome === "cancel") await cancelOrder(userId, order.id);
  return order;
}

async function main() {
  const db = getDb();
  const [asha] = await db.select().from(users).where(eq(users.id, DEMO_USER_ID)).limit(1);
  if (!asha) throw new Error("Run pnpm db:seed first.");
  // Roomier limits for the simulation, then the real ones are put back.
  await setSpendingRules(DEMO_USER_ID, { perOrderCents: 15_000, monthlyCents: 200_000, allowedStoreIds: [], undoWindowSeconds: 600 });
  await ensurePayPal(DEMO_USER_ID);

  // Shoppers browsing: each look at a product counts its missing information.
  const all = await db.select({ p: products, s: stores }).from(products).innerJoin(stores, eq(stores.id, products.storeId));
  const looks: Record<string, number> = { "NW-ROAD-LITE": 9, "NW-GRIP-HIKER": 6, "NW-ESSENTIAL-TEE": 4, "MH-NONSTICK-PAN": 7, "MH-WEIGHTED-BLANKET": 5, "MH-CHEF-KNIFE": 3 };
  for (const { p, s } of all) for (let i = 0; i < (looks[p.sku] ?? 1); i++) await recordBarrierHits(p, s);

  const placed = [
    await buy(DEMO_USER_ID, "NW-TRAIL-RUNNER-2", { size: "9" }, "capture"),
    await buy(DEMO_USER_ID, "NW-RUN-SOCKS-3", { size: "M (US 8-10)" }, "capture"),
    await buy(DEMO_USER_ID, "NW-ESSENTIAL-TEE", { size: "M", color: "Black" }, "cancel"), // wrong colour heard; cancelled in time
    await buy(DEMO_USER_ID, "MH-TALKING-SCALE", {}, "capture"),
    await buy(DEMO_USER_ID, "MH-BIG-BUTTON-CLOCK", {}, "cancel"),
    await buy(DEMO_USER_ID, "MH-STONE-MUG", {}, "capture"),
  ];

  // Pretend the undo windows of those orders are over, so Render's task charges them.
  const { captured } = await captureDueOrders(new Date(Date.now() + 11 * 60_000), 50);

  // One more that is still inside its undo window, for the "cancel that" demo.
  placed.push(await buy(DEMO_USER_ID, "NW-CLOUD-WALK", { size: "10" }, "hold"));

  await setSpendingRules(DEMO_USER_ID, { perOrderCents: 15_000, monthlyCents: 40_000, allowedStoreIds: (await db.select({ id: stores.id }).from(stores)).map((s) => s.id), undoWindowSeconds: 600 });
  console.log(`Simulated ${placed.length} orders (${captured.length} charged, 2 cancelled in the undo window) and shopper visits to ${all.length} products.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
