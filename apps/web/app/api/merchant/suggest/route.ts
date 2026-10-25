/** POST /api/merchant/suggest { barrierId } — an AI-drafted fix for the merchant to check. */
import { defaultModel } from "@open-aisle/core/agent";
import { draftFix } from "@open-aisle/core/barriers";
import { aiEnabled } from "@open-aisle/core";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { rateLimited } from "@/lib/rateLimit";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  if (rateLimited(req, "suggest", 20)) return fail("That's a lot of requests in a minute. Please wait a moment and try again.", 429);
  try {
    const { barrierId } = z.object({ barrierId: z.string().uuid() }).parse(await req.json());
    const model = aiEnabled() ? defaultModel() : undefined;
    return ok({ draft: await draftFix(barrierId, model) });
  } catch (err) {
    return handleError(err);
  }
}
