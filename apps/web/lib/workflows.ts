/**
 * Start the durable capture task on Render Workflows for a newly held order.
 * If Render isn't configured (local development), the local worker or
 * INLINE_WORKER sweep does the job instead.
 */
import "server-only";
import { Render } from "@renderinc/sdk";

export async function scheduleCapture(orderId: string, undoUntil: Date | null) {
  const key = process.env.RENDER_API_KEY;
  if (!key || !undoUntil) return { scheduled: false as const };
  const slug = process.env.RENDER_WORKFLOW_SLUG ?? "open-aisle-worker";
  try {
    const render = new Render({ token: key });
    const run = await render.workflows.startTask(`${slug}/captureAfterUndo`, [orderId, undoUntil.toISOString()], { idempotencyKey: `capture-${orderId}` });
    return { scheduled: true as const, taskRunId: run.taskRunId };
  } catch (err) {
    // The sweep task still catches this order; log and carry on.
    console.error("Could not start capture workflow", err);
    return { scheduled: false as const };
  }
}
