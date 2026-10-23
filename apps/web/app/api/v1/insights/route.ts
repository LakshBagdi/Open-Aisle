/** GET /api/v1/insights — sales kept, mistakes caught by the undo window, barriers fixed. */
import { storeInsights } from "@open-aisle/core/merchant";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return withStore(req, async (store) => ({ insights: await storeInsights(store.id) }));
}
