/**
 * PayPal webhooks: PayPal phones us when something happens to a payment.
 *
 * Three rules:
 *  1. Verify: ask PayPal "did you really send this?" before trusting it.
 *  2. Store once: PayPal may resend an event. The event id is unique in our
 *     table, so a second copy is noticed and ignored.
 *  3. Turn it into a plain sentence for the person.
 */
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { notifications, orders, refunds, stores, webhookEvents } from "../db/schema";
import { env } from "../env";
import { formatMoney, payPalToCents } from "../money";
import { rest } from "./client";

export type PayPalWebhookEvent = {
  id: string;
  event_type: string;
  resource_type?: string;
  resource: Record<string, any>;
  create_time?: string;
  summary?: string;
};

const HEADER_NAMES = {
  authAlgo: "paypal-auth-algo",
  certUrl: "paypal-cert-url",
  transmissionId: "paypal-transmission-id",
  transmissionSig: "paypal-transmission-sig",
  transmissionTime: "paypal-transmission-time",
} as const;

/** Ask PayPal to confirm the signature. Returns false for anything not verified. */
export async function verifyWebhook(headers: Headers, event: PayPalWebhookEvent): Promise<boolean> {
  const webhookId = env().PAYPAL_WEBHOOK_ID;
  if (!webhookId) return false;
  const get = (n: string) => headers.get(n) ?? "";
  try {
    const res = await rest<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
      auth_algo: get(HEADER_NAMES.authAlgo),
      cert_url: get(HEADER_NAMES.certUrl),
      transmission_id: get(HEADER_NAMES.transmissionId),
      transmission_sig: get(HEADER_NAMES.transmissionSig),
      transmission_time: get(HEADER_NAMES.transmissionTime),
      webhook_id: webhookId,
      webhook_event: event,
    });
    return res.verification_status === "SUCCESS";
  } catch {
    return false;
  }
}

export type HandleResult = "processed" | "duplicate" | "ignored";

/** Store the event once, then apply it to our orders. */
export async function handleWebhookEvent(event: PayPalWebhookEvent, verified: boolean): Promise<HandleResult> {
  const db = getDb();
  const inserted = await db
    .insert(webhookEvents)
    .values({
      paypalEventId: event.id,
      eventType: event.event_type,
      resourceId: event.resource?.id ?? null,
      payload: event,
      verified,
    })
    .onConflictDoNothing({ target: webhookEvents.paypalEventId })
    .returning({ id: webhookEvents.id });
  if (inserted.length === 0) return "duplicate";
  if (!verified) return "ignored";

  const rowId = inserted[0]!.id;
  try {
    const result = await applyEvent(event);
    await db.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, rowId));
    return result;
  } catch (err) {
    await db
      .update(webhookEvents)
      .set({ error: err instanceof Error ? err.message : String(err) })
      .where(eq(webhookEvents.id, rowId));
    throw err;
  }
}

async function applyEvent(event: PayPalWebhookEvent): Promise<HandleResult> {
  const db = getDb();
  const r = event.resource;

  switch (event.event_type) {
    case "PAYMENT.AUTHORIZATION.VOIDED": {
      const [order] = await db.select().from(orders).where(eq(orders.authorizationId, r.id)).limit(1);
      if (!order) return "ignored";
      // Usually our own cancel already did this; only act if it's news.
      if (order.status === "held") {
        await db.update(orders).set({ status: "voided", undoUntil: null }).where(eq(orders.id, order.id));
        await notify(order.userId, order.id, `Your order was cancelled. Nothing was charged.`);
      }
      return "processed";
    }

    case "PAYMENT.CAPTURE.COMPLETED": {
      const authId: string | undefined = r.supplementary_data?.related_ids?.authorization_id;
      const [order] = authId
        ? await db.select().from(orders).where(eq(orders.authorizationId, authId)).limit(1)
        : await db.select().from(orders).where(eq(orders.captureId, r.id)).limit(1);
      if (!order) return "ignored";
      if (order.status === "held") {
        await db.update(orders).set({ status: "captured", captureId: r.id, undoUntil: null }).where(eq(orders.id, order.id));
        const store = await storeName(order.storeId);
        await notify(order.userId, order.id, `Done. You paid ${formatMoney(order.amountCents, order.currency)} to ${store}.`);
      } else if (order.status === "captured" && !order.captureId) {
        // Our worker captured but crashed before saving the id.
        await db.update(orders).set({ captureId: r.id }).where(eq(orders.id, order.id));
      }
      return "processed";
    }

    case "PAYMENT.CAPTURE.REFUNDED": {
      // The resource is the refund. Its "up" link points at the capture.
      const captureId = String(r.links?.find((l: any) => l.rel === "up")?.href ?? "").split("/").pop();
      const [refund] = await db.select().from(refunds).where(eq(refunds.paypalRefundId, r.id)).limit(1);
      const [order] = refund
        ? await db.select().from(orders).where(eq(orders.id, refund.orderId)).limit(1)
        : captureId
          ? await db.select().from(orders).where(eq(orders.captureId, captureId)).limit(1)
          : [];
      if (!order) return "ignored";
      if (refund && refund.status !== "completed") await db.update(refunds).set({ status: "completed" }).where(eq(refunds.id, refund.id));
      if (order.status !== "refunded") {
        await db.update(orders).set({ status: "refunded" }).where(eq(orders.id, order.id));
        const cents = r.amount?.value ? payPalToCents(r.amount.value) : order.amountCents;
        const store = await storeName(order.storeId);
        await notify(order.userId, order.id, `${store} refunded ${formatMoney(cents, order.currency)} to your PayPal.`);
      }
      return "processed";
    }

    default:
      return "ignored";
  }
}

async function storeName(storeId: string) {
  const [s] = await getDb().select({ name: stores.name }).from(stores).where(eq(stores.id, storeId)).limit(1);
  return s?.name ?? "the store";
}

async function notify(userId: string, orderId: string, text: string) {
  await getDb().insert(notifications).values({ userId, orderId, text });
}
