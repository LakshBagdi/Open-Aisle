/**
 * The heart of Open Aisle, tested end to end:
 *   cart → read-back → confirm → PayPal hold → cancel or capture → return.
 * Plus every way the trust layer must say no.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { addToCart, removeFromCart } from "../src/cart";
import { closeDb, getDb } from "../src/db";
import { orders, paypalVault, products, spendingRules } from "../src/db/schema";
import { buildReadBack, cancelOrder, captureDueOrders, captureOrder, listOrders, OrderError, placeOrder, shipOrder, spendingSummary, startReturn, unreadNotifications } from "../src/orders";
import { ConfirmationError, issueConfirmation } from "../src/rules";
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

async function cartWithShoe() {
  return addToCart(world.user.id, world.shoe.id, { size: "9" });
}

describe("cart totals", () => {
  it("adds tax and free delivery over $50, all in cents", async () => {
    const cart = await cartWithShoe();
    expect(cart.totals).toMatchObject({ subtotalCents: 5499, taxCents: 454, deliveryCents: 0, totalCents: 5953 });
  });

  it("refuses a size that doesn't exist, and says which do", async () => {
    await expect(addToCart(world.user.id, world.shoe.id, { size: "13" })).rejects.toThrow(/Options: 8, 9, 10, 11/);
    await expect(addToCart(world.user.id, world.shoe.id, {})).rejects.toThrow(/choose a size/);
  });
});

describe("read-back", () => {
  it("is built from the cart and includes the undo window", async () => {
    const cart = await cartWithShoe();
    const rb = buildReadBack(cart, world.store, 600);
    expect(rb.lines).toEqual(["Trail Runner 2, size 9: $54.99"]);
    expect(rb.spoken).toContain("Total $59.53");
    expect(rb.spoken).toContain("10 minutes to cancel");
  });
});

describe("placing an order", () => {
  it("holds the money, then cancel releases it and nothing is charged", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const { order, message } = await placeOrder(world.user.id, cart.id, token);
    expect(order.status).toBe("held");
    expect(order.authorizationId).toMatch(/^AUTH-/);
    expect(message).toMatch(/held, not taken/);

    const cancelled = await cancelOrder(world.user.id, order.id);
    expect(cancelled.order.status).toBe("voided");
    expect(fake.state.authorizations.get(order.authorizationId!)?.status).toBe("VOIDED");
    expect(fake.state.captures.size).toBe(0);

    // The worker must never charge a cancelled order.
    const run = await captureDueOrders(new Date(Date.now() + 3600_000));
    expect(run.captured).toEqual([]);
  });

  it("charges only after the undo window ends, then ships and refunds", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const { order } = await placeOrder(world.user.id, cart.id, token);

    expect((await captureDueOrders(new Date())).captured).toEqual([]); // window still open
    const later = new Date(Date.now() + 601_000);
    expect((await captureDueOrders(later)).captured).toEqual([order.id]);
    expect((await captureDueOrders(later)).captured).toEqual([]); // never twice

    const [saved] = await getDb().select().from(orders).where(eq(orders.id, order.id));
    expect(saved!.status).toBe("captured");
    await expect(cancelOrder(world.user.id, order.id)).rejects.toThrow(/too late/i);

    const summary = await spendingSummary(world.user.id);
    expect(summary.totalCents).toBe(5953);
    expect((await listOrders(world.user.id))[0]!.status).toBe("captured");

    const tracking = await shipOrder(order.id);
    expect(tracking.carrier).toBe("USPS");

    const ret = await startReturn(world.user.id, order.id, "Too small");
    expect(ret.message).toMatch(/refund \$59\.53/);
    const notes = (await unreadNotifications(world.user.id)).map((n) => n.text);
    expect(notes.some((n) => n.startsWith("Done. You paid $59.53 to Northwind Outfitters"))).toBe(true);
  });
});

describe("the trust layer says no", () => {
  it("without a confirmation token from the app", async () => {
    const cart = await cartWithShoe();
    const before = fake.state.authorizations.size;
    await expect(placeOrder(world.user.id, cart.id, "made-up-by-the-ai")).rejects.toBeInstanceOf(ConfirmationError);
    expect(fake.state.authorizations.size).toBe(before);
  });

  it("if the cart changed after the read-back", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await addToCart(world.user.id, world.mug.id, {});
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toMatchObject({ code: "cart_changed" });
  });

  it("if the token is used twice", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const before = fake.state.authorizations.size;
    await placeOrder(world.user.id, cart.id, token);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toBeInstanceOf(ConfirmationError);
    expect(fake.state.authorizations.size).toBe(before + 1);
  });

  it("if the token expired", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token, new Date(Date.now() + 3 * 60_000))).rejects.toMatchObject({ code: "expired" });
  });

  it("if the order is over the per-order limit", async () => {
    await resetDb();
    world = await seedWorld(fake, { perOrderCents: 5000, monthlyCents: 20_000 });
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toThrow(/over your limit of \$50\.00 per order/);
  });

  it("if someone edits the limits in the database without re-signing", async () => {
    await getDb().update(spendingRules).set({ perOrderCents: 999_999 }).where(eq(spendingRules.userId, world.user.id));
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toThrow(/changed without being re-confirmed/);
  });

  it("if PayPal isn't connected", async () => {
    await resetDb();
    world = await seedWorld(fake, { connectPayPal: false });
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toBeInstanceOf(OrderError);
  });

  it("if the month's limit would be passed (held orders count too)", async () => {
    await resetDb();
    world = await seedWorld(fake, { perOrderCents: 10_000, monthlyCents: 10_000 });
    const first = await cartWithShoe();
    await placeOrder(world.user.id, first.id, (await issueConfirmation(world.user.id, first.id)).token);
    const second = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, second.id);
    await expect(placeOrder(world.user.id, second.id, token)).rejects.toThrow(/over your monthly limit\. You have \$40\.47 left/);
  });

  it("if PayPal declines: the order fails and nothing is charged", async () => {
    await resetDb();
    world = await seedWorld(fake, { perOrderCents: 100_000, monthlyCents: 200_000 });
    // $615.85 + 8.25% tax = $666.66, the total the fake PayPal always declines.
    const [pricey] = await getDb()
      .insert(products)
      .values({ storeId: world.store.id, sku: "NW-DECLINE", category: "outdoor", title: "Expedition Tent", priceCents: 61_585, images: [] })
      .returning();
    const cart = await addToCart(world.user.id, pricey!.id, {});
    expect(cart.totals!.totalCents).toBe(66_666);
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toThrow(/PayPal declined the payment\. Nothing was charged\./);
    const [failed] = await getDb().select().from(orders).where(eq(orders.cartId, cart.id));
    expect(failed!.status).toBe("failed");
  });
});

describe("cancel and capture at the same moment", () => {
  it("exactly one wins, and PayPal agrees with our database", async () => {
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    const { order } = await placeOrder(world.user.id, cart.id, token);
    const later = new Date(Date.now() + 601_000);

    await Promise.allSettled([cancelOrder(world.user.id, order.id, later), captureOrder(order.id, later)]);

    const [saved] = await getDb().select().from(orders).where(eq(orders.id, order.id));
    const atPayPal = fake.state.authorizations.get(order.authorizationId!)!.status;
    expect(["voided", "captured"]).toContain(saved!.status);
    expect(atPayPal).toBe(saved!.status === "voided" ? "VOIDED" : "CAPTURED");
  });
});

describe("the trust layer, more", () => {
  it("an empty cart can't be confirmed", async () => {
    const cart = await cartWithShoe();
    await removeFromCart(world.user.id, cart.id, world.shoe.id);
    await expect(issueConfirmation(world.user.id, cart.id)).rejects.toMatchObject({ code: "cart_empty" });
  });
});

describe("a hold PayPal no longer has", () => {
  async function placedWithLostHold() {
    const cart = await cartWithShoe();
    const { order } = await placeOrder(world.user.id, cart.id, (await issueConfirmation(world.user.id, cart.id)).token);
    // As if the hold expired at PayPal (or the fake PayPal restarted).
    await getDb().update(orders).set({ authorizationId: "AUTH-GONE" }).where(eq(orders.id, order.id));
    return order;
  }

  it("is marked failed (not retried forever), and the shopper is told nothing was charged", async () => {
    const order = await placedWithLostHold();
    expect(await captureOrder(order.id, new Date(Date.now() + 11 * 60_000))).toBe("expired");
    const [row] = await getDb().select().from(orders).where(eq(orders.id, order.id));
    expect(row!.status).toBe("failed");
    const notes = await unreadNotifications(world.user.id);
    expect(notes.map((n) => n.text)).toContain("Your order from Northwind Outfitters didn't go through, so nothing was charged. You can order it again.");
  });

  it("can still be cancelled", async () => {
    const order = await placedWithLostHold();
    expect((await cancelOrder(world.user.id, order.id)).message).toBe("Cancelled. Nothing was charged.");
  });
});

describe("a saved PayPal account that stopped working", () => {
  it("says to reconnect PayPal, charges nothing, and forgets the dead account", async () => {
    fake.state.paymentTokens.clear(); // as if the shopper removed Open Aisle in their PayPal account
    const holdsBefore = fake.state.authorizations.size;
    const cart = await cartWithShoe();
    const { token } = await issueConfirmation(world.user.id, cart.id);
    await expect(placeOrder(world.user.id, cart.id, token)).rejects.toThrow("Your saved PayPal account isn't working any more. Please connect PayPal again in Settings. Nothing was charged.");
    const vaults = await getDb().select().from(paypalVault).where(eq(paypalVault.userId, world.user.id));
    expect(vaults.every((v) => v.status === "removed")).toBe(true);
    expect(fake.state.authorizations.size).toBe(holdsBefore);
  });
});
