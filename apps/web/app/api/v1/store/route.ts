/** GET /api/v1/store — the store this API key belongs to. */
import { storeProfile } from "@open-aisle/core/merchant";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";

export async function GET(req: Request) {
  return withStore(req, async (store) => ({ store: storeProfile(store) }));
}
