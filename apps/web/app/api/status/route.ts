/**
 * GET /api/status — what the Shop page needs to pick up where the person left
 * off after a reload: the order still inside its undo window, and the cart.
 */
import { getDb } from "@open-aisle/core";
import { listOpenCarts } from "@open-aisle/core/cart";
import { stores } from "@open-aisle/core/db/schema";
import { formatMoney } from "@open-aisle/core/money";
import { latestHeldOrder } from "@open-aisle/core/orders";
import { eq } from "drizzle-orm";
import { handleError, ok } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const userId = await currentUserId();
    const [held, carts] = await Promise.all([latestHeldOrder(userId), listOpenCarts(userId)]);
    const heldOrder =
      held && held.undoUntil && held.undoUntil.getTime() > Date.now()
        ? {
            id: held.id,
            undoUntil: held.undoUntil.toISOString(),
            amount: formatMoney(held.amountCents, held.currency),
            store: (await getDb().select({ name: stores.name }).from(stores).where(eq(stores.id, held.storeId)).limit(1))[0]?.name ?? "",
          }
        : null;
    const cart = carts[0]?.totals ? { itemCount: carts[0].items.length, total: formatMoney(carts[0].totals.totalCents) } : null;
    return ok({ heldOrder, cart });
  } catch (err) {
    return handleError(err);
  }
}
