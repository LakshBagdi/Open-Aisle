/**
 * Everything Open Aisle does with money, as plain functions.
 *
 * The life of one purchase:
 *   save PayPal once (vault)  →  hold the money (authorize)
 *     → "cancel that"  → release the hold (void)      nothing charged
 *     → window ends    → take the money (capture)     charged
 *   later: add tracking, refund a return.
 */
import {
  ApiError,
  CheckoutPaymentIntent,
  OrdersController,
  PaymentsController,
  PaypalPaymentTokenUsageType,
  TransactionSearchController,
  VaultController,
  VaultTokenRequestType,
  ShipmentCarrier,
} from "@paypal/paypal-server-sdk";
import type { CartItem, CartTotals } from "../db/schema";
import { centsToPayPal, payPalToCents } from "../money";
import { getPayPal, PayPalError } from "./client";

/** Turn the SDK's error into ours, so callers deal with one error type. */
async function call<T>(label: string, fn: () => Promise<{ result: T }>): Promise<T> {
  try {
    return (await fn()).result;
  } catch (err) {
    if (err instanceof ApiError) {
      throw new PayPalError(`${label} failed (${err.statusCode})`, err.statusCode, err.result ?? err.body);
    }
    throw err;
  }
}

const vault = () => new VaultController(getPayPal());
const ordersApi = () => new OrdersController(getPayPal());
const payments = () => new PaymentsController(getPayPal());
const search = () => new TransactionSearchController(getPayPal());

// ─── 1. Save PayPal once ────────────────────────────────────────────────────

export type SetupTokenResult = { setupTokenId: string; approveUrl: string };

/**
 * Step one of saving PayPal: ask PayPal for a "setup token" and a page where
 * the person (or their helper) approves Open Aisle to charge them later.
 * No money moves here.
 */
export async function createSetupToken(opts: {
  returnUrl: string;
  cancelUrl: string;
  requestId: string;
}): Promise<SetupTokenResult> {
  const res = await call("Create setup token", () =>
    vault().createSetupToken({
      paypalRequestId: opts.requestId,
      body: {
        paymentSource: {
          paypal: {
            description: "Open Aisle pays only after you say yes to the exact order.",
            usageType: PaypalPaymentTokenUsageType.Merchant,
            permitMultiplePaymentTokens: false,
            experienceContext: {
              brandName: "Open Aisle",
              locale: "en-US",
              returnUrl: opts.returnUrl,
              cancelUrl: opts.cancelUrl,
            },
          },
        },
      },
    }),
  );
  const approveUrl = res.links?.find((l) => l.rel === "approve")?.href;
  if (!res.id || !approveUrl) throw new PayPalError("Setup token response had no approval link", 502, res);
  return { setupTokenId: res.id, approveUrl };
}

export type PaymentTokenResult = { paymentTokenId: string; customerId?: string; payerEmail?: string };

/** Step two: after approval, swap the setup token for a permanent payment token. */
export async function createPaymentToken(setupTokenId: string, requestId: string): Promise<PaymentTokenResult> {
  const res = await call("Create payment token", () =>
    vault().createPaymentToken({
      paypalRequestId: requestId,
      body: { paymentSource: { token: { id: setupTokenId, type: VaultTokenRequestType.SetupToken } } },
    }),
  );
  if (!res.id) throw new PayPalError("Payment token response had no id", 502, res);
  return {
    paymentTokenId: res.id,
    customerId: res.customer?.id,
    payerEmail: res.paymentSource?.paypal?.emailAddress,
  };
}

// ─── 2. Hold the money ──────────────────────────────────────────────────────

export type HoldResult = { paypalOrderId: string; authorizationId: string; expiresAt?: string };

/**
 * Create an order with intent AUTHORIZE, paid with the saved PayPal account.
 * The money is reserved on the person's account but not taken.
 *
 * With a saved account PayPal often authorizes straight away; if it doesn't,
 * we call authorize ourselves. Both paths end with an authorization ID.
 */
export async function holdPayment(opts: {
  paymentTokenId: string;
  referenceId: string; // our order id, so PayPal and our database line up
  storeName: string;
  items: CartItem[];
  totals: CartTotals;
  requestId: string; // same id = PayPal won't create a second order if we retry
}): Promise<HoldResult> {
  const { totals } = opts;
  const money = (cents: number) => ({ currencyCode: totals.currency, value: centsToPayPal(cents) });

  const order = await call("Create order", () =>
    ordersApi().createOrder({
      paypalRequestId: opts.requestId,
      prefer: "return=representation",
      body: {
        intent: CheckoutPaymentIntent.Authorize,
        purchaseUnits: [
          {
            referenceId: opts.referenceId,
            customId: opts.referenceId,
            description: `Open Aisle order at ${opts.storeName}`.slice(0, 127),
            softDescriptor: "OPENAISLE",
            amount: {
              currencyCode: totals.currency,
              value: centsToPayPal(totals.totalCents),
              breakdown: {
                itemTotal: money(totals.subtotalCents),
                taxTotal: money(totals.taxCents),
                shipping: money(totals.deliveryCents),
              },
            },
            items: opts.items.map((i) => ({
              name: describeItem(i).slice(0, 127),
              sku: i.sku,
              quantity: String(i.quantity),
              unitAmount: money(i.unitPriceCents),
            })),
          },
        ],
        paymentSource: { paypal: { vaultId: opts.paymentTokenId } },
      },
    }),
  );
  if (!order.id) throw new PayPalError("Order response had no id", 502, order);

  let auth = order.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  if (!auth?.id) {
    const authorized = await call("Authorize order", () =>
      ordersApi().authorizeOrder({ id: order.id!, paypalRequestId: `${opts.requestId}-auth`, prefer: "return=representation" }),
    );
    auth = authorized.purchaseUnits?.[0]?.payments?.authorizations?.[0];
  }
  if (!auth?.id) throw new PayPalError("PayPal did not authorize the payment", 402, order);
  if (auth.status && !["CREATED", "PENDING"].includes(auth.status)) {
    throw new PayPalError(`Authorization status was ${auth.status}`, 402, auth);
  }
  return { paypalOrderId: order.id, authorizationId: auth.id, expiresAt: auth.expirationTime };
}

export function describeItem(i: CartItem): string {
  const variant = Object.entries(i.variant)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ");
  return variant ? `${i.title} (${variant})` : i.title;
}

// ─── 3. Release or take the money ───────────────────────────────────────────

/** "Cancel that": release the hold. The whole amount is freed; nothing is charged. */
export async function releaseHold(authorizationId: string, requestId: string): Promise<void> {
  await call("Void authorization", async () => {
    const r = await payments().voidPayment({ authorizationId, paypalRequestId: requestId });
    return { result: r.result };
  });
}

export type CaptureResult = { captureId: string; status: string; amountCents: number };

/** The undo window has ended: take the money. */
export async function takePayment(authorizationId: string, requestId: string): Promise<CaptureResult> {
  const res = await call("Capture authorization", () =>
    payments().captureAuthorizedPayment({
      authorizationId,
      paypalRequestId: requestId,
      prefer: "return=representation",
      body: { finalCapture: true },
    }),
  );
  if (!res.id) throw new PayPalError("Capture response had no id", 502, res);
  return {
    captureId: res.id,
    status: res.status ?? "UNKNOWN",
    amountCents: res.amount ? payPalToCents(res.amount.value) : 0,
  };
}

// ─── 4. After the purchase ─────────────────────────────────────────────────

export async function refundPayment(opts: {
  captureId: string;
  amountCents: number;
  currency: string;
  note: string;
  requestId: string;
}): Promise<{ refundId: string; status: string }> {
  const res = await call("Refund capture", () =>
    payments().refundCapturedPayment({
      captureId: opts.captureId,
      paypalRequestId: opts.requestId,
      prefer: "return=representation",
      body: {
        amount: { currencyCode: opts.currency, value: centsToPayPal(opts.amountCents) },
        noteToPayer: opts.note.slice(0, 255),
      },
    }),
  );
  if (!res.id) throw new PayPalError("Refund response had no id", 502, res);
  return { refundId: res.id, status: res.status ?? "UNKNOWN" };
}

/** The store ships: tell PayPal the carrier and tracking number. */
export async function addTracking(opts: {
  paypalOrderId: string;
  captureId: string;
  trackingNumber: string;
  carrier: "USPS" | "UPS" | "FEDEX" | "DHL";
}): Promise<void> {
  await call("Add tracking", () =>
    ordersApi().createOrderTracking({
      id: opts.paypalOrderId,
      body: {
        captureId: opts.captureId,
        trackingNumber: opts.trackingNumber,
        carrier: opts.carrier as ShipmentCarrier,
        notifyPayer: true,
      },
    }),
  );
}

export async function getPayPalOrder(paypalOrderId: string) {
  return call("Get order", () => ordersApi().getOrder({ id: paypalOrderId }));
}

/** Merchant reporting: transactions between two dates. */
export async function searchTransactions(start: Date, end: Date) {
  const res = await call("Search transactions", () =>
    search().searchTransactions({
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      fields: "transaction_info",
      pageSize: 100,
    }),
  );
  return (res.transactionDetails ?? []).map((t) => ({
    id: t.transactionInfo?.transactionId,
    status: t.transactionInfo?.transactionStatus,
    amountCents: t.transactionInfo?.transactionAmount ? payPalToCents(t.transactionInfo.transactionAmount.value.replace("-", "")) : 0,
    date: t.transactionInfo?.transactionInitiationDate,
  }));
}
