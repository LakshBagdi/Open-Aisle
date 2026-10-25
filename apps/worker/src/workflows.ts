/**
 * Open Aisle's background work as Render Workflows tasks.
 *
 * Why a workflow and not a plain timer in the web server? The undo window is
 * a promise to the person: "nothing is charged for 10 minutes, then it is".
 * If the web server restarts during those 10 minutes, a plain timer is lost.
 * A Render Workflows task survives restarts and retries on failure, and the
 * capture itself is idempotent (same PayPal request id), so a retry never
 * charges twice.
 *
 * Tasks:
 *   captureAfterUndo(orderId, undoUntil)  started once per order by the web app
 *   sweepDueOrders()                      safety net: charges anything overdue
 *   draftBarrierFixes(storeId)            AI drafts for a store's open barriers
 */
import "@open-aisle/core/load-env";
import { task, type TaskContext } from "@renderinc/sdk/workflows";
import { env } from "@open-aisle/core";
import { defaultModel } from "@open-aisle/core/agent";
import { draftFix, listBarriers } from "@open-aisle/core/barriers";
import { captureDueOrders, captureOrder } from "@open-aisle/core/orders";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const captureAfterUndo = task(
  { name: "captureAfterUndo", retry: { maxRetries: 5, waitDurationMs: 30_000, backoffScaling: 2 }, timeoutSeconds: 3 * 24 * 3600 },
  async function captureAfterUndo(_ctx: TaskContext, orderId: string, undoUntilIso: string) {
    const wait = new Date(undoUntilIso).getTime() - Date.now();
    if (wait > 0) await sleep(wait + 1000);
    const outcome = await captureOrder(orderId);
    // "failed" throws so Render retries with backoff; everything else is final.
    if (outcome === "failed") throw new Error(`Capture failed for ${orderId}; will retry`);
    if (outcome === "not_due") throw new Error(`Order ${orderId} not due yet; will retry`);
    return { orderId, outcome };
  },
);

export const sweepDueOrders = task({ name: "sweepDueOrders", timeoutSeconds: 300 }, async function sweepDueOrders(_ctx: TaskContext) {
  return captureDueOrders(new Date(), 100);
});

export const draftBarrierFixes = task({ name: "draftBarrierFixes", timeoutSeconds: 900 }, async function draftBarrierFixes(_ctx: TaskContext, storeId: string) {
  const model = env().ANTHROPIC_API_KEY ? defaultModel() : undefined;
  const open = (await listBarriers(storeId)).filter((b) => b.status === "open" && !b.suggestedFix);
  for (const b of open) await draftFix(b.id, model);
  return { drafted: open.length };
});
