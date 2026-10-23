/**
 * The Merchant API's logic: keys, store isolation, ship and refund through
 * PayPal, the fix board, and the insight numbers.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordBarrierHits, scanStoreBarriers } from "../src/barriers";
import { addToCart } from "../src/cart";
import { closeDb, getDb } from "../src/db";
import { merchantApiKeys, orders, products, stores } from "../src/db/schema";
import {
  analyticsDataset,
  applyStoreFix,
  authenticateApiKey,
  createApiKey,
  listStoreBarriers,
  listStoreOrders,
  MerchantError,
  refundStoreOrder,
  revokeApiKey,
  setBarrierStatus,
  shipStoreOrder,
  storeInsights,
} from "../src/merchant";
import { cancelOrder, captureDueOrders, placeOrder, unreadNotifications } from "../src/orders";
import { issueConfirmation } from "../src/rules";
import { resetDb, seedWorld, startFakePayPal } from "./helpers";

let fake: Awaited<ReturnType<typeof startFakePayPal>>;
let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.stop();
  await closeDb();
});
beforeEach(async () => {
  await resetDb();
  world = await seedWorld(fake);
});

async function paidOrder() {
  const cart = await addToCart(world.user.id, world.shoe.id, { size: "9" });
  const { token } = await issueConfirmation(world.user.id, cart.id);
  const { order } = await placeOrder(world.user.id, cart.id, token);
  await captureDueOrders(new Date(Date.now() + 11 * 60_000));
  return order;
}

describe("API keys", () => {
  it("works with the key, and only the hash is stored", async () => {
    const { key } = await createApiKey(world.store.id, "test");
    expect(key).toMatch(/^oa_/);
    const store = await authenticateApiKey(`Bearer ${key}`);
    expect(store.id).toBe(world.store.id);
    const rows = await getDb().select().from(merchantApiKeys);
    expect(JSON.stringify(rows)).not.toContain(key);
  });

  it("refuses a missing, wrong or revoked key", async () => {
    await expect(authenticateApiKey(null)).rejects.toBeInstanceOf(MerchantError);
    await expect(authenticateApiKey("Bearer oa_not_a_real_key")).rejects.toThrow(/isn't valid/);
    const { key, id } = await createApiKey(world.store.id);
    await revokeApiKey(world.store.id, id!);
    await expect(authenticateApiKey(`Bearer ${key}`)).rejects.toThrow(/revoked/);
  });
});

describe("orders", () => {
  it("a store sees only its own orders", async () => {
    await paidOrder();
    const [other] = await getDb().insert(stores).values({ slug: "other", name: "Other Store" }).returning();
    expect(await listStoreOrders(other!.id)).toEqual([]);
    const mine = await listStoreOrders(world.store.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: "captured", amount: "$59.53" });
  });

  it("ships with the merchant's tracking number, sent to PayPal", async () => {
    const order = await paidOrder();
    const shipped = await shipStoreOrder(world.store.id, order.id, "UPS", "1Z999AA10123456784");
    expect(shipped.tracking).toMatchObject({ carrier: "UPS", trackingNumber: "1Z999AA10123456784" });
    const paypalOrder = fake.state.orders.get(order.paypalOrderId!);
    expect(JSON.stringify(paypalOrder)).toContain("1Z999AA10123456784");
    await expect(shipStoreOrder(world.store.id, order.id, "UPS")).rejects.toThrow(/already has tracking/);
  });

  it("refunds through PayPal once, and the shopper is told", async () => {
    const order = await paidOrder();
    await unreadNotifications(world.user.id); // clear earlier messages
    const r = await refundStoreOrder(world.store.id, order.id, "Item returned");
    expect(r.status).toBe("completed");
    expect(r.order.status).toBe("refunded");
    expect([...fake.state.refunds.values()]).toHaveLength(1);
    const notes = await unreadNotifications(world.user.id);
    expect(notes.map((n) => n.text).join(" ")).toContain("Northwind Outfitters refunded $59.53");
    await expect(refundStoreOrder(world.store.id, order.id, "again")).rejects.toThrow(/already has a refund|Only paid orders/);
  });

  it("won't refund an order that is still only held", async () => {
    const cart = await addToCart(world.user.id, world.shoe.id, { size: "9" });
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const { order } = await placeOrder(world.user.id, cart.id, token);
    await expect(refundStoreOrder(world.store.id, order.id, "x")).rejects.toThrow(/hasn't been charged/);
  });
});

describe("fix board", () => {
  it("moves a barrier to in progress, and only a real fix closes it", async () => {
    await scanStoreBarriers(world.store.id);
    const [mugBarrier] = await listStoreBarriers(world.store.id, "open");
    expect(mugBarrier).toBeDefined();
    await setBarrierStatus(world.store.id, mugBarrier!.id, "in_progress");
    expect((await listStoreBarriers(world.store.id, "in_progress")).map((b) => b.id)).toContain(mugBarrier!.id);
    await expect(applyStoreFix(world.store.id, mugBarrier!.id, "Returns within __ days")).rejects.toThrow(/Fill in the blanks/);
  });

  it("writes the fix into the catalog", async () => {
    const [mug] = await getDb().select().from(products).where(eq(products.id, world.mug.id));
    await recordBarrierHits(mug!, world.store);
    const alt = (await listStoreBarriers(world.store.id)).find((b) => b.kind === "missing_alt_text");
    await applyStoreFix(world.store.id, alt!.id, "A white stoneware mug with a round handle.");
    const [after] = await getDb().select().from(products).where(eq(products.id, world.mug.id));
    expect(after!.images[0]!.alt).toBe("A white stoneware mug with a round handle.");
  });

  it("can't touch another store's barrier", async () => {
    await scanStoreBarriers(world.store.id);
    const [b] = await listStoreBarriers(world.store.id);
    const [other] = await getDb().insert(stores).values({ slug: "other2", name: "Other" }).returning();
    await expect(setBarrierStatus(other!.id, b!.id, "dismissed")).rejects.toThrow(/No barrier/);
  });
});

describe("insights", () => {
  it("counts sales kept and mistakes caught by the undo window", async () => {
    await paidOrder();
    const cart = await addToCart(world.user.id, world.shoe.id, { size: "10" });
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const { order } = await placeOrder(world.user.id, cart.id, token);
    await cancelOrder(world.user.id, order.id);

    const i = await storeInsights(world.store.id);
    expect(i.orders).toMatchObject({ captured: 1, voided: 1 });
    expect(i.revenueCents).toBe(5953);
    expect(i.cancelsCaught).toBe(1);

    const data = await analyticsDataset([world.store.id]);
    expect(data.orders).toHaveLength(2);
    expect(data.orders.map((o) => o.cancelled_in_undo).sort()).toEqual([0, 1]);
    // No shopper ids leave the database.
    expect(JSON.stringify(data)).not.toContain(world.user.id);
    expect((await getDb().select().from(orders)).length).toBe(2);
  });
});
