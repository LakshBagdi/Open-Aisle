/**
 * GET /api/notifications — plain sentences about the person's orders
 * ("Done. You paid $59.53 to Northwind Outfitters."). Each is returned once.
 *
 * In local development (no Render worker running) this also charges orders
 * whose undo window ended, so the app works with a single command.
 */
import { captureDueOrders, unreadNotifications } from "@open-aisle/core/orders";
import { handleError, ok } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    if (process.env.INLINE_WORKER === "true") await captureDueOrders();
    const rows = await unreadNotifications(await currentUserId());
    return ok({ notifications: rows.map((n) => ({ id: n.id, text: n.text, orderId: n.orderId, at: n.createdAt })) });
  } catch (err) {
    return handleError(err);
  }
}
