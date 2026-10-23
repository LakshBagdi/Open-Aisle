/**
 * /confirm/<cartId>?fp=<fingerprint>
 *
 * Where a person confirms an order that ANOTHER AI agent put together through
 * Open Aisle's MCP server. The page is built by our code from the database,
 * not by the agent, so what the person reads is the real cart. The fingerprint
 * in the link must still match the cart: if the agent changed anything after
 * checkout, the link stops working.
 */
import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import { getDb } from "@open-aisle/core";
import { getCart } from "@open-aisle/core/cart";
import { spendingRules, stores } from "@open-aisle/core/db/schema";
import { buildReadBack } from "@open-aisle/core/orders";
import { cartFingerprint, checkSpending } from "@open-aisle/core/rules";
import { currentUserId } from "@/lib/session";
import { ConfirmOrder } from "./ConfirmOrder";

export const metadata: Metadata = { title: "Confirm your order" };
export const dynamic = "force-dynamic";

function Problem({ title, text }: { title: string; text: string }) {
  return (
    <div className="page-intro">
      <h1>{title}</h1>
      <p>{text}</p>
      <p>
        <a href="/">Go to Open Aisle</a>
      </p>
    </div>
  );
}

export default async function ConfirmPage(props: { params: Promise<{ cartId: string }>; searchParams: Promise<{ fp?: string }> }) {
  const { cartId } = await props.params;
  const { fp } = await props.searchParams;
  const userId = await currentUserId();

  const cart = await getCart(userId, cartId).catch(() => null);
  if (!cart) return <Problem title="Order not found" text="This link doesn't match a cart in your account." />;
  if (cart.status !== "open") return <Problem title="Already ordered" text="This cart has already been ordered. Check My orders for its status." />;
  if (cart.items.length === 0) return <Problem title="Nothing to order" text="This cart is empty." />;
  if (!fp || fp !== cartFingerprint(cart)) {
    return <Problem title="This order changed" text="The cart changed after this link was made, so it can't be used. Ask your assistant to check out again, and you'll get a new link." />;
  }

  const db = getDb();
  const [store] = await db.select().from(stores).where(eq(stores.id, cart.storeId)).limit(1);
  const [rules] = await db.select().from(spendingRules).where(eq(spendingRules.userId, userId)).limit(1);
  const rb = buildReadBack(cart, store!, rules?.undoWindowSeconds ?? 600, "en");
  const check = await checkSpending(userId, cart.storeId, cart.totals!.totalCents, cart.totals!.currency);

  return (
    <>
      <div className="page-intro">
        <h1>Confirm your order</h1>
        <p>Your assistant put this order together. Open Aisle wrote this summary from the store's own data. Nothing is paid until you confirm.</p>
      </div>
      <ConfirmOrder
        data={{
          cartId: cart.id,
          fingerprint: fp,
          storeName: rb.storeName,
          lines: rb.lines,
          totalLine: rb.totalLine,
          deliveryLine: rb.deliveryLine,
          undoLine: rb.undoLine,
          spoken: rb.spoken,
          blockedReason: check.ok ? undefined : check.reason,
        }}
      />
    </>
  );
}
