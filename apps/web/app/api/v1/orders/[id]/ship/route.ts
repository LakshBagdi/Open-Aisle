/**
 * POST /api/v1/orders/{id}/ship  { carrier, trackingNumber? }
 * Adds tracking to the PayPal order (Orders v2 /track); the shopper hears
 * "Your order is on its way".
 */
import { shipStoreOrder } from "@open-aisle/core/merchant";
import { z } from "zod";
import { jsonBody, withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Body = z.object({
  carrier: z.enum(["USPS", "UPS", "FEDEX", "DHL"]).default("USPS"),
  trackingNumber: z.string().trim().min(5).max(64).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const body = Body.parse(await jsonBody(req));
    return { order: await shipStoreOrder(store.id, id, body.carrier, body.trackingNumber) };
  });
}
