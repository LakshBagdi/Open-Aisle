/**
 * The Merchant API's logic: what a store's own systems can do with Open Aisle.
 *
 *   keys       create / check / revoke API keys (we keep only a hash)
 *   orders     list the store's orders, ship one (PayPal tracking), refund one (PayPal refund)
 *   barriers   list, move on the fix board, get an AI draft, apply a fix
 *   insights   the numbers behind the dashboard: sales kept, cancels caught, barriers fixed
 *
 * Every function takes the store id from the API key, never from the request
 * body, so one store can never read or change another store's data.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDb } from "../db";
import { aiRuns, barriers, merchantApiKeys, notifications, orders, products, refunds, stores, type Barrier, type Store } from "../db/schema";
import { formatMoney } from "../money";
import { refundPayment } from "../paypal";
import { applyBarrierFix, draftFix, listBarriers } from "../barriers";
import { OrderError, shipOrder } from "../orders";
import type { LanguageModel } from "ai";

export class MerchantError extends Error {
  constructor(
    public code: "unauthorized" | "not_found" | "conflict" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "MerchantError";
  }
}

// ─── API keys ───────────────────────────────────────────────────────────────

const KEY_PREFIX = "oa_";

/** Keys are 32 random bytes, so a fast hash is safe (no dictionary to guess from). */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Make a new key. The full key is returned ONCE; we only store its hash. */
export async function createApiKey(storeId: string, label = "default", fixedKey?: string) {
  const key = fixedKey ?? `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const [row] = await getDb()
    .insert(merchantApiKeys)
    .values({ storeId, label, keyHash: hashApiKey(key), prefix: key.slice(0, 10) })
    .onConflictDoNothing({ target: merchantApiKeys.keyHash })
    .returning();
  return { key, id: row?.id, prefix: key.slice(0, 10) };
}

/** Turn an `Authorization: Bearer oa_...` header into the store it belongs to. */
export async function authenticateApiKey(authorization: string | null): Promise<Store> {
  const key = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!key || !key.startsWith(KEY_PREFIX)) throw new MerchantError("unauthorized", "Send your API key as: Authorization: Bearer oa_...");
  const db = getDb();
  const [row] = await db
    .select({ key: merchantApiKeys, store: stores })
    .from(merchantApiKeys)
    .innerJoin(stores, eq(stores.id, merchantApiKeys.storeId))
    .where(and(eq(merchantApiKeys.keyHash, hashApiKey(key)), isNull(merchantApiKeys.revokedAt)))
    .limit(1);
  if (!row) throw new MerchantError("unauthorized", "That API key isn't valid or was revoked.");
  await db.update(merchantApiKeys).set({ lastUsedAt: new Date() }).where(eq(merchantApiKeys.id, row.key.id));
  return row.store;
}

export async function revokeApiKey(storeId: string, keyId: string) {
  const r = await getDb()
    .update(merchantApiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(merchantApiKeys.id, keyId), eq(merchantApiKeys.storeId, storeId)))
    .returning({ id: merchantApiKeys.id });
  if (r.length === 0) throw new MerchantError("not_found", "No such key.");
}

// ─── Store profile ──────────────────────────────────────────────────────────

export function storeProfile(s: Store) {
  return {
    id: s.id,
    slug: s.slug,
    name: s.name,
    returnPolicy: s.returnPolicy,
    deliveryDays: s.deliveryDays,
    deliveryCents: s.deliveryCents,
    freeDeliveryOverCents: s.freeDeliveryOverCents,
    taxRateBasisPoints: s.taxRateBasisPoints,
  };
}

// ─── Orders ─────────────────────────────────────────────────────────────────

type OrderStatus = (typeof orders.$inferSelect)["status"];

function orderView(o: typeof orders.$inferSelect) {
  return {
    id: o.id,
    status: o.status,
    amountCents: o.amountCents,
    amount: formatMoney(o.amountCents, o.currency),
    currency: o.currency,
    items: o.items.map((i) => ({ sku: i.sku, title: i.title, variant: i.variant, quantity: i.quantity, unitPriceCents: i.unitPriceCents })),
    totals: o.totals,
    paypalOrderId: o.paypalOrderId,
    captureId: o.captureId,
    undoUntil: o.undoUntil?.toISOString() ?? null,
    tracking: o.tracking ?? null,
    createdAt: o.createdAt.toISOString(),
  };
}
export type MerchantOrder = ReturnType<typeof orderView>;

export async function listStoreOrders(storeId: string, opts: { status?: OrderStatus; limit?: number } = {}) {
  const where = [eq(orders.storeId, storeId)];
  if (opts.status) where.push(eq(orders.status, opts.status));
  const rows = await getDb()
    .select()
    .from(orders)
    .where(and(...where))
    .orderBy(desc(orders.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  return rows.map(orderView);
}

async function storeOrder(storeId: string, orderId: string) {
  const [o] = await getDb().select().from(orders).where(and(eq(orders.id, orderId), eq(orders.storeId, storeId))).limit(1);
  if (!o) throw new MerchantError("not_found", "No order with that id at this store.");
  return o;
}

export async function getStoreOrder(storeId: string, orderId: string) {
  return orderView(await storeOrder(storeId, orderId));
}

/** The store ships: PayPal gets the tracking number, the shopper hears "it's on its way". */
export async function shipStoreOrder(storeId: string, orderId: string, carrier: "USPS" | "UPS" | "FEDEX" | "DHL" = "USPS", trackingNumber?: string) {
  const o = await storeOrder(storeId, orderId);
  if (o.tracking) throw new MerchantError("conflict", "This order already has tracking.");
  try {
    await shipOrder(o.id, carrier, trackingNumber);
  } catch (err) {
    if (err instanceof OrderError) throw new MerchantError("conflict", err.message);
    throw err;
  }
  return getStoreOrder(storeId, orderId);
}

/**
 * The store refunds an order (a return arrived, or a goodwill refund).
 * Full refund through PayPal; the webhook then tells the shopper out loud.
 */
export async function refundStoreOrder(storeId: string, orderId: string, reason: string) {
  const o = await storeOrder(storeId, orderId);
  if (o.status === "held") throw new MerchantError("conflict", "This order hasn't been charged yet. The shopper can still cancel it, or it will be voided.");
  if (o.status !== "captured" || !o.captureId) throw new MerchantError("conflict", `Only paid orders can be refunded (this one is ${o.status}).`);
  const db = getDb();
  const [existing] = await db.select().from(refunds).where(eq(refunds.orderId, o.id)).limit(1);
  if (existing) throw new MerchantError("conflict", "This order already has a refund.");

  const [row] = await db.insert(refunds).values({ orderId: o.id, amountCents: o.amountCents, reason }).returning();
  const res = await refundPayment({
    captureId: o.captureId,
    amountCents: o.amountCents,
    currency: o.currency,
    note: `Refund: ${reason}`.slice(0, 255),
    requestId: `refund-${row!.id}`,
  });
  const done = res.status === "COMPLETED";
  await db.update(refunds).set({ paypalRefundId: res.refundId, status: done ? "completed" : "pending" }).where(eq(refunds.id, row!.id));
  if (done) {
    // Same as a shopper-started return: mark it and tell the shopper. If PayPal's
    // PAYMENT.CAPTURE.REFUNDED webhook arrives later it sees "refunded" and stays quiet.
    await db.update(orders).set({ status: "refunded" }).where(eq(orders.id, o.id));
    await db.insert(notifications).values({
      userId: o.userId,
      orderId: o.id,
      text: `${(await storeName(storeId)) ?? "The store"} refunded ${formatMoney(o.amountCents, o.currency)} to your PayPal.`,
    });
  }
  return { refundId: res.refundId, status: done ? "completed" : "pending", order: await getStoreOrder(storeId, orderId) };
}

async function storeName(storeId: string) {
  const [s] = await getDb().select({ name: stores.name }).from(stores).where(eq(stores.id, storeId)).limit(1);
  return s?.name;
}

// ─── Barriers ───────────────────────────────────────────────────────────────

export type BarrierStatus = Barrier["status"];

export async function listStoreBarriers(storeId: string, status?: BarrierStatus) {
  const all = await listBarriers(storeId);
  return status ? all.filter((b) => b.status === status) : all;
}

async function storeBarrier(storeId: string, barrierId: string) {
  const [b] = await getDb().select().from(barriers).where(and(eq(barriers.id, barrierId), eq(barriers.storeId, storeId))).limit(1);
  if (!b) throw new MerchantError("not_found", "No barrier with that id at this store.");
  return b;
}

/**
 * Move a barrier on the fix board. "fixed" can't be set here: a barrier is
 * only fixed when real information is written into the catalog (applyStoreFix).
 */
export async function setBarrierStatus(storeId: string, barrierId: string, status: "open" | "in_progress" | "dismissed") {
  const b = await storeBarrier(storeId, barrierId);
  if (b.status === "fixed") throw new MerchantError("conflict", "This barrier is already fixed.");
  await getDb().update(barriers).set({ status }).where(eq(barriers.id, b.id));
  return { id: b.id, status };
}

export async function draftStoreFix(storeId: string, barrierId: string, model?: LanguageModel) {
  await storeBarrier(storeId, barrierId);
  return draftFix(barrierId, model);
}

export async function applyStoreFix(storeId: string, barrierId: string, text: string) {
  const fix = text.trim();
  if (fix.length < 3) throw new MerchantError("invalid", "The fix is too short.");
  if (fix.includes("__")) throw new MerchantError("invalid", "Fill in the blanks (__) first. Open Aisle never guesses measurements or policies.");
  await storeBarrier(storeId, barrierId);
  await applyBarrierFix(storeId, barrierId, fix);
  return { id: barrierId, status: "fixed" as const };
}

// ─── Insights ───────────────────────────────────────────────────────────────

/**
 * The headline numbers for a store. "Cancels caught" = orders the shopper
 * cancelled during the undo window: mistakes that never became a charge,
 * a refund, or a dispute.
 */
export async function storeInsights(storeId: string) {
  const db = getDb();
  const byStatus = await db
    .select({ status: orders.status, count: sql<number>`count(*)::int`, cents: sql<number>`coalesce(sum(${orders.amountCents}),0)::int` })
    .from(orders)
    .where(eq(orders.storeId, storeId))
    .groupBy(orders.status);
  const get = (s: OrderStatus) => byStatus.find((r) => r.status === s) ?? { count: 0, cents: 0 };

  const barrierRows = await db
    .select({ status: barriers.status, count: sql<number>`count(*)::int`, hits: sql<number>`coalesce(sum(${barriers.timesHit}),0)::int` })
    .from(barriers)
    .where(eq(barriers.storeId, storeId))
    .groupBy(barriers.status);
  const b = (s: BarrierStatus) => barrierRows.find((r) => r.status === s) ?? { count: 0, hits: 0 };

  const top = await db
    .select({ id: barriers.id, kind: barriers.kind, timesHit: barriers.timesHit, product: products.title })
    .from(barriers)
    .innerJoin(products, eq(products.id, barriers.productId))
    .where(and(eq(barriers.storeId, storeId), inArray(barriers.status, ["open", "in_progress"])))
    .orderBy(desc(barriers.timesHit))
    .limit(3);

  return {
    orders: {
      held: get("held").count,
      captured: get("captured").count,
      voided: get("voided").count,
      refunded: get("refunded").count,
      failed: get("failed").count,
    },
    revenueCents: get("captured").cents,
    refundedCents: get("refunded").cents,
    cancelsCaught: get("voided").count,
    cancelsCaughtCents: get("voided").cents,
    barriers: {
      open: b("open").count + b("in_progress").count,
      fixed: b("fixed").count,
      shopperHits: barrierRows.reduce((s, r) => s + r.hits, 0),
      top,
    },
  };
}

// ─── Data for the analytics dashboard (AG Studio) ──────────────────────────

/**
 * Flat rows, one table per subject, ready for a dashboard's data engine.
 * Money in dollars (numbers) because charts plot numbers, dates as ISO days.
 * Nothing here identifies a shopper.
 */
export async function analyticsDataset(storeIds?: string[]) {
  const db = getDb();
  const storeFilter = storeIds?.length ? inArray(orders.storeId, storeIds) : undefined;
  const orderRows = await db
    .select({ o: orders, store: stores.name })
    .from(orders)
    .innerJoin(stores, eq(stores.id, orders.storeId))
    .where(storeFilter)
    .orderBy(orders.createdAt);

  const barrierRows = await db
    .select({ b: barriers, store: stores.name, product: products.title, category: products.category })
    .from(barriers)
    .innerJoin(stores, eq(stores.id, barriers.storeId))
    .innerJoin(products, eq(products.id, barriers.productId))
    .where(storeIds?.length ? inArray(barriers.storeId, storeIds) : undefined);

  const turnRows = await db.select().from(aiRuns).where(eq(aiRuns.step, "turn")).orderBy(aiRuns.createdAt).limit(2000);

  const day = (d: Date) => d.toISOString().slice(0, 10);
  return {
    orders: orderRows.map(({ o, store }) => ({
      order_id: o.id.slice(0, 8),
      day: day(o.createdAt),
      store,
      status: o.status,
      amount: o.amountCents / 100,
      // Split by outcome so a dashboard can simply sum a column.
      paid: o.status === "captured" ? o.amountCents / 100 : 0,
      caught_by_undo: o.status === "voided" ? o.amountCents / 100 : 0,
      items: o.items.reduce((s, i) => s + i.quantity, 0),
      cancelled_in_undo: o.status === "voided" ? 1 : 0,
    })),
    barriers: barrierRows.map(({ b, store, product, category }) => ({
      store,
      product,
      category,
      kind: b.kind.replace(/_/g, " "),
      status: b.status.replace(/_/g, " "),
      shopper_hits: b.timesHit,
    })),
    agent_turns: turnRows.map((r) => {
      const out = (r.output ?? {}) as { grounding?: { passed?: boolean; problems?: string[] }; steps?: number };
      const problems = out.grounding?.problems ?? [];
      return {
        day: day(r.createdAt),
        model: r.model,
        prompt_version: r.promptVersion,
        passed_first_time: problems.length === 0 ? 1 : 0,
        rewritten: problems.some((p) => p.startsWith("first draft")) ? 1 : 0,
        seconds: (r.durationMs ?? 0) / 1000,
        tokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
      };
    }),
  };
}
