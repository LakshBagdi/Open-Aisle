/**
 * PATCH /api/v1/barriers/{id}  { status: "open" | "in_progress" | "dismissed" }
 * Moves a barrier on the fix board. To mark it fixed, POST .../fix with the real information.
 */
import { setBarrierStatus } from "@open-aisle/core/merchant";
import { z } from "zod";
import { jsonBody, withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Body = z.object({ status: z.enum(["open", "in_progress", "dismissed"]) });

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { status } = Body.parse(await jsonBody(req));
    return { barrier: await setBarrierStatus(store.id, id, status) };
  });
}
