/**
 * POST /api/paypal/webhook — PayPal tells us about holds, charges and refunds.
 * We verify with PayPal, store the event once, then update the order.
 * We always answer 200 quickly for events we've stored, so PayPal doesn't
 * keep resending them.
 */
import { handleWebhookEvent, verifyWebhook, type PayPalWebhookEvent } from "@open-aisle/core/paypal";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  let event: PayPalWebhookEvent;
  try {
    event = (await req.json()) as PayPalWebhookEvent;
    if (!event?.id || !event?.event_type) throw new Error("not an event");
  } catch {
    return NextResponse.json({ error: "Invalid webhook body" }, { status: 400 });
  }
  const verified = await verifyWebhook(req.headers, event);
  try {
    const result = await handleWebhookEvent(event, verified);
    return NextResponse.json({ received: true, verified, result });
  } catch (err) {
    console.error("webhook processing failed", event.event_type, err);
    // 500 makes PayPal retry later; the event is stored with its error.
    return NextResponse.json({ error: "processing failed" }, { status: 500 });
  }
}
