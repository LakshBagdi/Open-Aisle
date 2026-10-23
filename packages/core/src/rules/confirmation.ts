/**
 * Confirmation tokens: proof that the person said yes to ONE exact cart.
 *
 * Analogy: a ticket stamped with a photo of the cart. The ticket only works
 * once, only for two minutes, and only if the cart still looks exactly like
 * the photo. If anything changed after the read-back (one item, one cent),
 * the ticket is rejected and the person hears the read-back again.
 *
 * Only the companion app's Confirm action can create a token. The AI agent has
 * no tool that creates one.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { getDb } from "../db";
import { carts, confirmationTokens, type Cart } from "../db/schema";
import { env } from "../env";

export const CONFIRM_TTL_MS = 2 * 60 * 1000;

/** A fingerprint of everything the person heard in the read-back. */
export function cartFingerprint(cart: Pick<Cart, "id" | "storeId" | "items" | "totals">): string {
  const items = [...cart.items]
    .map((i) => ({ p: i.productId, s: i.sku, v: Object.entries(i.variant).sort(), q: i.quantity, c: i.unitPriceCents }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const t = cart.totals;
  const canonical = JSON.stringify({
    id: cart.id,
    store: cart.storeId,
    items,
    totals: t ? [t.subtotalCents, t.taxCents, t.deliveryCents, t.totalCents, t.currency] : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** We store only a keyed hash of the token, never the token itself. */
function hashToken(token: string): string {
  return createHmac("sha256", env().CONFIRM_TOKEN_SECRET).update(token).digest("hex");
}

/**
 * Called only by the app's Confirm action. `heardFingerprint` is the
 * fingerprint of the read-back the person actually heard; if the cart changed
 * since, no token is issued.
 */
export async function issueConfirmation(userId: string, cartId: string, now = new Date(), heardFingerprint?: string) {
  const db = getDb();
  const [cart] = await db.select().from(carts).where(and(eq(carts.id, cartId), eq(carts.userId, userId))).limit(1);
  if (!cart) throw new ConfirmationError("cart_not_found", "I couldn't find that cart.");
  if (cart.status !== "open") throw new ConfirmationError("cart_closed", "That cart has already been ordered.");
  if (cart.items.length === 0 || !cart.totals) throw new ConfirmationError("cart_empty", "Your cart is empty.");
  if (heardFingerprint !== undefined && heardFingerprint !== cartFingerprint(cart)) {
    throw new ConfirmationError("cart_changed", "Your cart changed after I read it back, so I didn't pay. Let me read it again.");
  }

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + CONFIRM_TTL_MS);
  await db.insert(confirmationTokens).values({ tokenHash: hashToken(token), userId, cartId, cartHash: cartFingerprint(cart), expiresAt });
  return { token, expiresAt };
}

export class ConfirmationError extends Error {
  constructor(
    public code: "cart_not_found" | "cart_closed" | "cart_empty" | "invalid" | "expired" | "used" | "cart_changed",
    message: string,
  ) {
    super(message);
    this.name = "ConfirmationError";
  }
}

/**
 * Use the token. Succeeds once. Marks it used in the same database statement
 * that checks it, so two requests racing with the same token can't both win.
 */
export async function consumeConfirmation(userId: string, cartId: string, token: string, now = new Date()): Promise<Cart> {
  const db = getDb();
  const tokenHash = hashToken(token);
  const [row] = await db.select().from(confirmationTokens).where(eq(confirmationTokens.tokenHash, tokenHash)).limit(1);
  if (!row || row.userId !== userId || row.cartId !== cartId) throw new ConfirmationError("invalid", "That confirmation isn't valid. Let me read the order back again.");
  if (!timingSafeEqual(Buffer.from(row.tokenHash), Buffer.from(tokenHash))) throw new ConfirmationError("invalid", "That confirmation isn't valid.");
  if (row.usedAt) throw new ConfirmationError("used", "That confirmation was already used.");
  if (row.expiresAt <= now) throw new ConfirmationError("expired", "That confirmation timed out. Let me read the order back again.");

  const [cart] = await db.select().from(carts).where(eq(carts.id, cartId)).limit(1);
  if (!cart || cart.status !== "open") throw new ConfirmationError("cart_closed", "That cart has already been ordered.");
  if (cartFingerprint(cart) !== row.cartHash) {
    throw new ConfirmationError("cart_changed", "Your cart changed after I read it back, so I didn't pay. Let me read it again.");
  }

  const claimed = await db
    .update(confirmationTokens)
    .set({ usedAt: now })
    .where(and(eq(confirmationTokens.id, row.id), isNull(confirmationTokens.usedAt), gt(confirmationTokens.expiresAt, now)))
    .returning({ id: confirmationTokens.id });
  if (claimed.length === 0) throw new ConfirmationError("used", "That confirmation was already used.");
  return cart;
}
