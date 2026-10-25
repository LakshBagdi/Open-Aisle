/** POST /api/orders/:id/return { reason } — start a return; the store refunds to PayPal. */
import { startReturn } from "@open-aisle/core/orders";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

const Body = z.object({ reason: z.string().trim().min(2).max(200) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { reason } = Body.parse(await req.json());
    const r = await startReturn(await currentUserId(), id, reason);
    return ok({ message: r.message });
  } catch (err) {
    return handleError(err);
  }
}
