/** GET /api/v1/orders/{id} — one order. */
import { getStoreOrder } from "@open-aisle/core/merchant";
import { z } from "zod";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    return { order: await getStoreOrder(store.id, id) };
  });
}
