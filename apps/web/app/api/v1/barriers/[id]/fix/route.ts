/**
 * POST /api/v1/barriers/{id}/fix  { text }
 * Writes the information into the catalog and closes the barrier. The next
 * shopper hears it. Text with blanks ("__") is refused.
 */
import { applyStoreFix } from "@open-aisle/core/merchant";
import { z } from "zod";
import { jsonBody, withStore } from "@/lib/merchant";

export const runtime = "nodejs";

const Body = z.object({ text: z.string().trim().min(3).max(2000) });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const { text } = Body.parse(await jsonBody(req));
    return { barrier: await applyStoreFix(store.id, id, text) };
  });
}
