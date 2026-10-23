/**
 * POST /api/v1/orders/{id}/refund  { reason }
 * Full refund through PayPal (captures/{id}/refund). The shopper hears it.
 */
import { refundStoreOrder } from "@open-aisle/core/merchant";
import { z } from "zod";
import { jsonBody, withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(2).max(200) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { reason } = Body.parse(await jsonBody(req));
    return await refundStoreOrder(store.id, id, reason);
  });
}
