/**
 * POST /api/orders/confirm  { cartId, fingerprint }
 *
 * The ONLY way money moves forward. Called when the person presses Confirm
 * in the read-back dialog, or says the confirm phrase while it is open.
 *
 * `fingerprint` identifies the exact cart the person heard. If the cart has
 * changed since, nothing is paid and they hear the read-back again.
 * The AI agent runs on the server and has no way to call this.
 */
import { placeOrder } from "@open-aisle/core/orders";
import { issueConfirmation } from "@open-aisle/core/rules";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { rateLimited } from "@/lib/rateLimit";
import { currentUserId } from "@/lib/session";
import { scheduleCapture } from "@/lib/workflows";

export const runtime = "nodejs";

const Body = z.object({ cartId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  if (rateLimited(req, "confirm", 10)) return fail("That's a lot of requests in a minute. Please wait a moment and try again.", 429);
  try {
    const { cartId, fingerprint } = Body.parse(await req.json());
    const userId = await currentUserId();
    const { token } = await issueConfirmation(userId, cartId, new Date(), fingerprint);
    const { order, message } = await placeOrder(userId, cartId, token);
    // Durable timer on Render Workflows: charge when the undo window ends.
    await scheduleCapture(order.id, order.undoUntil);
    return ok({ orderId: order.id, status: order.status, undoUntil: order.undoUntil, message });
  } catch (err) {
    return handleError(err);
  }
}
