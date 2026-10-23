/** POST /api/paypal/connect — start saving PayPal; returns PayPal's approval page link. */
import { startPayPalConnection } from "@open-aisle/core/account";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const { approveUrl } = await startPayPalConnection(await currentUserId());
    return ok({ approveUrl });
  } catch (err) {
    return handleError(err);
  }
}
