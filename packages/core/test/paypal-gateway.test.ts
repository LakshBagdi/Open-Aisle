/**
 * The official PayPal SDK, pointed at the fake PayPal, doing a full lifecycle:
 * save PayPal → hold → void, hold → capture → refund.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetEnv } from "../src/env";
import { createFakePayPal } from "../src/paypal/fake/fakePayPal";
import {
  createPaymentToken,
  createSetupToken,
  holdPayment,
  PayPalError,
  refundPayment,
  releaseHold,
  resetPayPal,
  takePayment,
} from "../src/paypal";
import type { CartItem, CartTotals } from "../src/db/schema";

const fake = createFakePayPal();

beforeAll(async () => {
  process.env.PAYPAL_API_BASE = await fake.start();
  resetEnv();
  resetPayPal();
});
afterAll(() => fake.stop());

const items: CartItem[] = [{ productId: "p1", sku: "RUN-9-BLK", title: "Trail runner", variant: { size: "9", color: "Black" }, quantity: 1, unitPriceCents: 4999 }];
const totals: CartTotals = { subtotalCents: 4999, taxCents: 412, deliveryCents: 0, totalCents: 5411, currency: "USD", deliveryEstimate: "Thursday" };

async function savedToken() {
  const st = await createSetupToken({ returnUrl: "http://app/return", cancelUrl: "http://app/cancel", requestId: crypto.randomUUID() });
  expect(st.approveUrl).toContain("/fake/approve/");
  await expect(createPaymentToken(st.setupTokenId, crypto.randomUUID())).rejects.toBeInstanceOf(PayPalError);
  fake.approve(st.setupTokenId);
  const pt = await createPaymentToken(st.setupTokenId, crypto.randomUUID());
  expect(pt.paymentTokenId).toMatch(/^PT-/);
  expect(pt.payerEmail).toBe("asha.buyer@example.com");
  return pt.paymentTokenId;
}

describe("PayPal gateway (official SDK against the fake)", () => {
  it("holds, then releases: nothing charged, capture refused", async () => {
    const token = await savedToken();
    const hold = await holdPayment({ paymentTokenId: token, referenceId: "order-1", storeName: "Northwind", items, totals, requestId: crypto.randomUUID() });
    expect(hold.authorizationId).toMatch(/^AUTH-/);
    await releaseHold(hold.authorizationId, crypto.randomUUID());
    await expect(takePayment(hold.authorizationId, crypto.randomUUID())).rejects.toMatchObject({ status: 422 });
  });

  it("holds, captures, refunds", async () => {
    const token = await savedToken();
    const hold = await holdPayment({ paymentTokenId: token, referenceId: "order-2", storeName: "Northwind", items, totals, requestId: crypto.randomUUID() });
    const cap = await takePayment(hold.authorizationId, crypto.randomUUID());
    expect(cap.amountCents).toBe(5411);
    await expect(releaseHold(hold.authorizationId, crypto.randomUUID())).rejects.toMatchObject({ status: 422 });
    const ref = await refundPayment({ captureId: cap.captureId, amountCents: 5411, currency: "USD", note: "Return", requestId: crypto.randomUUID() });
    expect(ref.status).toBe("COMPLETED");
  });

  it("same request id never creates a second order", async () => {
    const token = await savedToken();
    const requestId = crypto.randomUUID();
    const a = await holdPayment({ paymentTokenId: token, referenceId: "order-3", storeName: "N", items, totals, requestId });
    const b = await holdPayment({ paymentTokenId: token, referenceId: "order-3", storeName: "N", items, totals, requestId });
    expect(b.paypalOrderId).toBe(a.paypalOrderId);
  });

  it("PayPal rejects totals that don't add up", async () => {
    const token = await savedToken();
    const bad = { ...totals, totalCents: totals.totalCents + 1 };
    await expect(holdPayment({ paymentTokenId: token, referenceId: "x", storeName: "N", items, totals: bad, requestId: crypto.randomUUID() })).rejects.toMatchObject({ status: 422 });
  });
});
