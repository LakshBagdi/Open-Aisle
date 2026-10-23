/**
 * POST /api/merchant/studio-ai — one AI turn for AG Studio's assistant, run on Claude.
 * Body: the AgLlmRequest AG Studio built (conversation, instructions, tool schemas).
 * Answer: { text, toolCalls, usage, model }. The tools themselves run in the browser.
 */
import { defaultModel } from "@open-aisle/core/agent";
import { getDb } from "@open-aisle/core";
import { aiRuns } from "@open-aisle/core/db/schema";
import { runStudioTurn, type StudioRequest } from "@open-aisle/core/studio";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY = 1_500_000; // AG Studio sends its schema and tool list each turn

const Body = z.object({
  input: z.array(z.record(z.string(), z.unknown())).max(400),
  instructions: z.string().max(200_000).optional(),
  tools: z.array(z.object({ name: z.string().max(200), description: z.string(), parameters: z.record(z.string(), z.unknown()) })).max(100).optional(),
  toolChoice: z.union([z.enum(["auto", "none", "required"]), z.object({ name: z.string() })]).optional(),
  responseFormat: z
    .union([z.object({ type: z.literal("text") }), z.object({ type: z.literal("json"), name: z.string(), description: z.string().optional(), schema: z.record(z.string(), z.unknown()) })])
    .optional(),
});

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const raw = await req.text();
    if (raw.length > MAX_BODY) return fail("That request is too large.", 413);
    const body = Body.parse(JSON.parse(raw)) as StudioRequest;
    const started = Date.now();
    const turn = await runStudioTurn(body, defaultModel());
    await getDb()
      .insert(aiRuns)
      .values({
        step: "studio",
        model: turn.model,
        promptVersion: "studio-v1",
        output: { toolCalls: turn.toolCalls.map((c) => c.name), textChars: turn.text.length },
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        durationMs: Date.now() - started,
      });
    return ok(turn);
  } catch (err) {
    return handleError(err);
  }
}
