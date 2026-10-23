/** GET /api/v1/orders?status=captured&limit=50 — the store's orders, newest first. */
import { listStoreOrders } from "@open-aisle/core/merchant";
import { z } from "zod";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Query = z.object({
  status: z.enum(["held", "voided", "captured", "refunded", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(req: Request) {
  return withStore(req, async (store) => {
    const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
    return { orders: await listStoreOrders(store.id, q) };
  });
}
