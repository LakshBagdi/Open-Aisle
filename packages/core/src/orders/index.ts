/**
 * Orders: where the person's "yes" turns into a PayPal hold, and the hold
 * turns into a charge (or into nothing, if they change their mind).
 *
 *   placeOrder   confirmation token + spending rules → PayPal hold     ("held")
 *   cancelOrder  inside the undo window              → PayPal void     ("voided")
 *   captureDue   undo window ended (worker)          → PayPal capture  ("captured")
 *   shipOrder    store ships                         → PayPal tracking
 *   startReturn  person returns it                   → PayPal refund   ("refunded")
 *
 * Cancel and capture can race (person says "cancel" the second the window
 * ends). Both lock the order row first, so exactly one of them wins.
 */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../db";
import { carts, notifications, orders, paypalVault, refunds, stores, users, type Order } from "../db/schema";
import { formatMoney } from "../money";
import { addTracking, holdPayment, PayPalError, refundPayment, releaseHold, takePayment } from "../paypal";
import { checkSpending, consumeConfirmation } from "../rules";
import { t, type Lang } from "../i18n";

export class OrderError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "OrderError";
  }
}

async function langOf(userId: string): Promise<Lang> {
  const [u] = await getDb().select({ language: users.language }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.language ?? "en";
}

async function notify(userId: string, orderId: string | null, text: string) {
  await getDb().insert(notifications).values({ userId, orderId, text });
}

export type PlaceResult = { order: Order; message: string };

/**
 * The only path that moves money forward. Needs the one-time token the app
 * created when the person confirmed the read-back. The AI can't create one.
 */
export async function placeOrder(userId: string, cartId: string, confirmationToken: string, now = new Date()): Promise<PlaceResult> {
  const db = getDb();
  const lang = await langOf(userId);

  // 1. The person really said yes to exactly this cart.
  const cart = await consumeConfirmation(userId, cartId, confirmationToken, now);
  const totals = cart.totals!;

  // 2. Their signed spending rules allow it.
  const check = await checkSpending(userId, cart.storeId, totals.totalCents, totals.currency, now);
  if (!check.ok) throw new OrderError("rules", check.reason);

  // 3. PayPal is connected.
  const [vault] = await db.select().from(paypalVault).where(and(eq(paypalVault.userId, userId), eq(paypalVault.status, "active"))).limit(1);
  if (!vault?.paymentTokenId) throw new OrderError("no_paypal", "Your PayPal isn't connected yet. You can connect it in Settings.");

  const [store] = await db.select().from(stores).where(eq(stores.id, cart.storeId)).limit(1);
  if (!store) throw new OrderError("no_store", "Store not found.");

  // 4. Write our order first, so PayPal's reference id is our order id.
  const [order] = await db
    .insert(orders)
    .values({ userId, storeId: cart.storeId, cartId: cart.id, items: cart.items, totals, amountCents: totals.totalCents, currency: totals.currency, status: "held" })
    .returning();

  try {
    const hold = await holdPayment({
      paymentTokenId: vault.paymentTokenId,
      referenceId: order!.id,
      storeName: store.name,
      items: cart.items,
      totals,
      requestId: `hold-${order!.id}`,
    });
    const undoUntil = new Date(now.getTime() + check.rules.undoWindowSeconds * 1000);
    const [updated] = await db
      .update(orders)
      .set({ paypalOrderId: hold.paypalOrderId, authorizationId: hold.authorizationId, undoUntil })
      .where(eq(orders.id, order!.id))
      .returning();
    await db.update(carts).set({ status: "ordered" }).where(eq(carts.id, cart.id));
    const message = t(lang, "order.held", { minutes: String(Math.round(check.rules.undoWindowSeconds / 60)) });
    await notify(userId, order!.id, message);
    return { order: updated!, message };
  } catch (err) {
    const reason = err instanceof PayPalError ? payPalReason(err) : "Something went wrong talking to PayPal.";
    await db.update(orders).set({ status: "failed", failureReason: reason }).where(eq(orders.id, order!.id));
    // The saved account no longer works (removed at PayPal): forget it, so the read-back asks to reconnect next time.
    if (savedAccountGone(paypalIssue(err))) await db.update(paypalVault).set({ status: "removed" }).where(eq(paypalVault.id, vault.id));
    throw new OrderError("paypal", `${reason} Nothing was charged.`);
  }
}

function payPalReason(err: PayPalError): string {
  const issue = (err.details as any)?.details?.[0]?.issue as string | undefined;
  if (issue === "INSTRUMENT_DECLINED") return "PayPal declined the payment.";
  if (issue === "PAYER_ACTION_REQUIRED") return "PayPal needs you to approve this payment in PayPal.";
  if (savedAccountGone(issue)) return "Your saved PayPal account isn't working any more. Please connect PayPal again in Settings.";
  return "PayPal couldn't place the order.";
}

function savedAccountGone(issue: string | undefined) {
  return issue === "INVALID_VAULT_ID" || issue === "PAYMENT_SOURCE_DECLINED_BY_PROCESSOR" || issue === "PAYMENT_SOURCE_CANNOT_BE_USED";
}

function paypalIssue(err: unknown): string | undefined {
  return err instanceof PayPalError ? ((err.details as any)?.details?.[0]?.issue as string | undefined) : undefined;
}
/** PayPal has no usable hold any more: nothing can be charged or released. */
function holdIsGone(issue: string | undefined) {
  return issue === "INVALID_RESOURCE_ID" || issue === "AUTHORIZATION_EXPIRED";
}

/** "Cancel that." Works only inside the undo window. */
export async function cancelOrder(userId: string, orderId: string, now = new Date()): Promise<{ order: Order; message: string }> {
  const lang = await langOf(userId);
  return getDb().transaction(async (tx) => {
    const [order] = await tx
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.userId, userId)))
      .for("update");
    if (!order) throw new OrderError("not_found", "I couldn't find that order.");
    if (order.status === "voided") return { order, message: t(lang, "order.voided") };
    if (order.status !== "held" || !order.authorizationId) throw new OrderError("too_late", t(lang, "order.tooLate"));

    try {
      await releaseHold(order.authorizationId, `void-${order.id}`);
    } catch (err) {
      // A hold PayPal no longer has (expired, or unknown) can't be charged either: cancelling is still true.
      if (!holdIsGone(paypalIssue(err))) throw err;
    }
    const [updated] = await tx.update(orders).set({ status: "voided", undoUntil: null }).where(eq(orders.id, order.id)).returning();
    const message = t(lang, "order.voided");
    await tx.insert(notifications).values({ userId, orderId: order.id, text: message });
    return { order: updated!, message };
  });
}

/** The latest held order, so "cancel that" needs no order number. */
export async function latestHeldOrder(userId: string) {
  const [o] = await getDb()
    .select()
    .from(orders)
    .where(and(eq(orders.userId, userId), eq(orders.status, "held")))
    .orderBy(desc(orders.createdAt))
    .limit(1);
  return o;
}

/**
 * Worker task: charge every held order whose undo window has ended.
 * Safe to run on several machines at once: SKIP LOCKED means each order is
 * handled by exactly one of them. Safe to retry: the PayPal request id is
 * fixed per order, so a retry never charges twice.
 */
export async function captureDueOrders(now = new Date(), limit = 20): Promise<{ captured: string[]; failed: string[] }> {
  const db = getDb();
  const captured: string[] = [];
  const failed: string[] = [];

  const due = await db
    .select({ id: orders.id })
    .from(orders)
    .where(and(eq(orders.status, "held"), lte(orders.undoUntil, now)))
    .limit(limit);

  for (const { id } of due) {
    const r = await captureOrder(id, now);
    if (r === "captured") captured.push(id);
    else if (r === "failed") failed.push(id);
  }
  return { captured, failed };
}

export type CaptureOutcome = "captured" | "voided" | "not_due" | "skipped" | "failed" | "expired";

/**
 * Charge ONE order if its undo window has ended. Used by the sweep above and
 * by the Render Workflows task that waits for each order's window.
 * Locks the row (SKIP LOCKED), so a cancel or another worker can't race it.
 */
export async function captureOrder(id: string, now = new Date()): Promise<CaptureOutcome> {
  return getDb().transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, id)).for("update", { skipLocked: true });
    if (!order || order.status !== "held" || !order.authorizationId) return "skipped";
    if (!order.undoUntil || order.undoUntil > now) return "not_due";
    try {
      const cap = await takePayment(order.authorizationId, `capture-${order.id}`);
      await tx.update(orders).set({ status: "captured", captureId: cap.captureId, undoUntil: null }).where(eq(orders.id, order.id));
      const [store] = await tx.select({ name: stores.name }).from(stores).where(eq(stores.id, order.storeId));
      const lang = await langOf(order.userId);
      await tx.insert(notifications).values({
        userId: order.userId,
        orderId: order.id,
        text: t(lang, "order.captured", { amount: formatMoney(order.amountCents, order.currency), store: store?.name ?? "the store" }),
      });
      return "captured";
    } catch (err) {
      const issue = paypalIssue(err);
      if (holdIsGone(issue)) {
        // The hold expired or PayPal doesn't know it: it can never be charged, so stop retrying and say so.
        await tx.update(orders).set({ status: "failed", undoUntil: null }).where(eq(orders.id, order.id));
        const [store] = await tx.select({ name: stores.name }).from(stores).where(eq(stores.id, order.storeId));
        await tx.insert(notifications).values({ userId: order.userId, orderId: order.id, text: t(await langOf(order.userId), "order.failed", { store: store?.name ?? "the store" }) });
        return "expired"; // final: nothing to retry
      }
      if (issue === "AUTHORIZATION_VOIDED") {
        await tx.update(orders).set({ status: "voided", undoUntil: null }).where(eq(orders.id, order.id));
        return "voided";
      }
      if (issue === "AUTHORIZATION_ALREADY_CAPTURED") {
        // An earlier attempt succeeded but we crashed before saving. The webhook fills in the capture id.
        await tx.update(orders).set({ status: "captured", undoUntil: null }).where(eq(orders.id, order.id));
        return "captured";
      }
      return "failed"; // stays "held"; the next attempt retries with the same request id
    }
  });
}

/** Store side: ship it and tell PayPal the tracking number. */
export async function shipOrder(orderId: string, carrier: "USPS" | "UPS" | "FEDEX" | "DHL" = "USPS", givenTrackingNumber?: string) {
  const db = getDb();
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
  if (!order) throw new OrderError("not_found", "Order not found.");
  if (order.status !== "captured" || !order.captureId || !order.paypalOrderId) throw new OrderError("not_captured", "Only paid orders can be shipped.");
  // Demo stores don't have a real carrier account, so they get a made-up USPS-style number.
  const trackingNumber = givenTrackingNumber ?? `9400${Math.floor(Math.random() * 1e16).toString().padStart(16, "0")}`;
  await addTracking({ paypalOrderId: order.paypalOrderId, captureId: order.captureId, trackingNumber, carrier });
  const tracking = { carrier, trackingNumber, status: "Shipped", eta: order.totals.deliveryEstimate };
  await db.update(orders).set({ tracking }).where(eq(orders.id, order.id));
  await notify(order.userId, order.id, `Your order is on its way with ${carrier}. It should arrive ${order.totals.deliveryEstimate}.`);
  return tracking;
}

/** Person returns it. Demo stores accept returns straight away and refund through PayPal. */
export async function startReturn(userId: string, orderId: string, reason: string) {
  const db = getDb();
  const lang = await langOf(userId);
  const [order] = await db.select().from(orders).where(and(eq(orders.id, orderId), eq(orders.userId, userId))).limit(1);
  if (!order) throw new OrderError("not_found", "I couldn't find that order.");
  if (order.status === "held") throw new OrderError("still_held", "This order hasn't been charged yet, so you can simply cancel it.");
  if (order.status !== "captured" || !order.captureId) throw new OrderError("not_returnable", "This order can't be returned.");
  const [existing] = await db.select().from(refunds).where(eq(refunds.orderId, order.id)).limit(1);
  if (existing) throw new OrderError("already", "A return for this order has already been started.");

  const [store] = await db.select().from(stores).where(eq(stores.id, order.storeId)).limit(1);
  const [row] = await db.insert(refunds).values({ orderId: order.id, amountCents: order.amountCents, reason }).returning();
  const res = await refundPayment({ captureId: order.captureId, amountCents: order.amountCents, currency: order.currency, note: `Return: ${reason}`, requestId: `refund-${row!.id}` });
  const done = res.status === "COMPLETED";
  await db.update(refunds).set({ paypalRefundId: res.refundId, status: done ? "completed" : "pending" }).where(eq(refunds.id, row!.id));
  if (done) await db.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id));
  const message = t(lang, "order.refundStarted", { store: store?.name ?? "The store", amount: formatMoney(order.amountCents, order.currency) });
  await notify(userId, order.id, message);
  return { message, refundId: res.refundId };
}

export async function listOrders(userId: string, limit = 50) {
  return getDb()
    .select({
      id: orders.id,
      createdAt: orders.createdAt,
      status: orders.status,
      amountCents: orders.amountCents,
      currency: orders.currency,
      items: orders.items,
      tracking: orders.tracking,
      undoUntil: orders.undoUntil,
      storeName: stores.name,
    })
    .from(orders)
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .where(eq(orders.userId, userId))
    .orderBy(desc(orders.createdAt))
    .limit(limit);
}

export async function spendingSummary(userId: string, now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await getDb()
    .select({ store: stores.name, total: sql<number>`sum(${orders.amountCents})::int`, count: sql<number>`count(*)::int` })
    .from(orders)
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .where(and(eq(orders.userId, userId), inArray(orders.status, ["held", "captured"]), gte(orders.createdAt, start)))
    .groupBy(stores.name);
  return { since: start, byStore: rows, totalCents: rows.reduce((s, r) => s + r.total, 0) };
}

export async function unreadNotifications(userId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(notifications)
    .where(and(eq(notifications.userId, userId), sql`${notifications.readAt} is null`))
    .orderBy(notifications.createdAt);
  if (rows.length) await db.update(notifications).set({ readAt: new Date() }).where(and(eq(notifications.userId, userId), sql`${notifications.readAt} is null`));
  return rows;
}

export { buildReadBack, type ReadBack } from "./readback";
