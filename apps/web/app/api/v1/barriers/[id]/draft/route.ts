/**
 * POST /api/v1/barriers/{id}/draft — an AI-drafted fix to check (Claude vision
 * for photo descriptions; fill-in templates for facts only the store knows).
 */
import { defaultModel } from "@open-aisle/core/agent";
import { aiEnabled } from "@open-aisle/core";
import { draftStoreFix } from "@open-aisle/core/merchant";
import { z } from "zod";
import { withStore } from "@/lib/merchant";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withStore(req, async (store) => {
    const id = z.string().uuid().parse((await ctx.params).id);
    const model = aiEnabled() ? defaultModel() : undefined;
    return { draft: await draftStoreFix(store.id, id, model) };
  });
}
