/** GET /api/v1/barriers?status=open — missing information shoppers hit, most-hit first. */
import { listStoreBarriers } from "@open-aisle/core/merchant";
import { z } from "zod";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Query = z.object({ status: z.enum(["open", "in_progress", "fixed", "dismissed"]).optional() });

export async function GET(req: Request) {
  return withStore(req, async (store) => {
    const { status } = Query.parse(Object.fromEntries(new URL(req.url).searchParams));
    const rows = await listStoreBarriers(store.id, status);
    return {
      barriers: rows.map((b) => ({
        id: b.id,
        kind: b.kind,
        detail: b.detail,
        status: b.status,
        timesHit: b.timesHit,
        suggestedFix: b.suggestedFix,
        lastHitAt: b.lastHitAt?.toISOString() ?? null,
        product: { id: b.productId, title: b.productTitle, sku: b.sku },
      })),
    };
  });
}
