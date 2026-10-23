/**
 * The store pages' own API (the barrier report and the fix board).
 *
 * GET   /api/merchant/barriers?store=<id>                      the store's barriers
 * POST  /api/merchant/barriers  { storeId, barrierId, fix }    accept a fix (writes it into the catalog)
 * PATCH /api/merchant/barriers  { storeId, barrierId, status } move it on the fix board
 *
 * Demo scope: no merchant sign-in, so these are same-origin only. A store's
 * own systems use the Merchant API (/api/v1) with an API key instead.
 */
import { listStores } from "@open-aisle/core/catalog";
import { applyStoreFix, listStoreBarriers, MerchantError, setBarrierStatus } from "@open-aisle/core/merchant";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const stores = await listStores();
    const storeId = new URL(req.url).searchParams.get("store") ?? stores[0]?.id;
    if (!storeId) return ok({ stores: [], barriers: [] });
    return ok({ stores: stores.map((s) => ({ id: s.id, name: s.name })), storeId, barriers: await listStoreBarriers(storeId) });
  } catch (err) {
    return handleError(err);
  }
}

function merchantFail(err: unknown) {
  if (err instanceof MerchantError) return fail(err.message, err.code === "not_found" ? 404 : err.code === "invalid" ? 422 : 409);
  return handleError(err);
}

const FixBody = z.object({ storeId: z.string().uuid(), barrierId: z.string().uuid(), fix: z.string().trim().min(3).max(2000) });

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const { storeId, barrierId, fix } = FixBody.parse(await req.json());
    await applyStoreFix(storeId, barrierId, fix);
    return ok({ message: "Fixed. Shoppers will hear this from now on." });
  } catch (err) {
    return merchantFail(err);
  }
}

const StatusBody = z.object({ storeId: z.string().uuid(), barrierId: z.string().uuid(), status: z.enum(["open", "in_progress", "dismissed"]) });
const MOVED: Record<z.infer<typeof StatusBody>["status"], string> = {
  open: "Moved back to Needs a fix.",
  in_progress: "Moved to Being fixed.",
  dismissed: "Marked as not needed.",
};

export async function PATCH(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const { storeId, barrierId, status } = StatusBody.parse(await req.json());
    await setBarrierStatus(storeId, barrierId, status);
    return ok({ message: MOVED[status] });
  } catch (err) {
    return merchantFail(err);
  }
}
