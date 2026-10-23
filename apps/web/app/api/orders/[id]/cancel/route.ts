/** POST /api/orders/:id/cancel  — release the PayPal hold during the undo window. */
import { cancelOrder } from "@open-aisle/core/orders";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const { id } = await ctx.params;
    const r = await cancelOrder(await currentUserId(), id);
    return ok({ status: r.order.status, message: r.message });
  } catch (err) {
    return handleError(err);
  }
}
