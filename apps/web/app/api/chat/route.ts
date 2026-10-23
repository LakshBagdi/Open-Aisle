/**
 * POST /api/chat  { text, conversationId? }
 * One turn with the shopping agent. Returns the reply and any events
 * (read-back to show, cart changed, order cancelled).
 *
 * GET /api/chat?conversationId=...  the conversation so far.
 */
import { conversationMessages, runTurn } from "@open-aisle/core/agent";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({
  text: z.string().trim().min(1).max(2000),
  conversationId: z.string().uuid().optional(),
});

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const body = Body.parse(await req.json());
    const result = await runTurn({ userId: await currentUserId(), text: body.text, conversationId: body.conversationId });
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("conversationId");
  if (!id) return ok({ messages: [] });
  return ok({ messages: await conversationMessages(await currentUserId(), id) });
}
