/**
 * GET /api/merchant/analytics?store=<id> — flat tables for the insights
 * dashboard (orders, barriers, agent turns). No shopper is identifiable.
 */
import { listStores } from "@open-aisle/core/catalog";
import { env } from "@open-aisle/core";
import { analyticsDataset } from "@open-aisle/core/merchant";
import { handleError, ok } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const stores = await listStores();
    const store = new URL(req.url).searchParams.get("store");
    const ids = store && store !== "all" ? [store] : undefined;
    return ok({
      stores: stores.map((s) => ({ id: s.id, name: s.name })),
      data: await analyticsDataset(ids),
      ai: Boolean(env().ANTHROPIC_API_KEY),
    });
  } catch (err) {
    return handleError(err);
  }
}
