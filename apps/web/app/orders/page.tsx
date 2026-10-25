import type { Metadata } from "next";
import { listOrders, spendingSummary } from "@open-aisle/core/orders";
import { getAccountStatus } from "@open-aisle/core/account";
import { formatMoney } from "@open-aisle/core/money";
import { OrdersGrid, type OrderRow } from "@/components/OrdersGrid";
import { OrderActions, type ActionableOrder } from "@/components/OrderActions";
import { currentUserId } from "@/lib/session";

export const metadata: Metadata = { title: "My orders" };
export const dynamic = "force-dynamic";

const STATUS = { held: "Held, can cancel", voided: "Cancelled, not charged", captured: "Paid", refunded: "Refunded", failed: "Failed, not charged" } as const;

export default async function OrdersPage() {
  const userId = await currentUserId();
  const [orders, summary, account] = await Promise.all([listOrders(userId), spendingSummary(userId), getAccountStatus(userId)]);
  const rows: OrderRow[] = orders.map((o) => ({
    id: o.id,
    date: o.createdAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
    store: o.storeName,
    items: o.items.map((i) => `${i.quantity > 1 ? `${i.quantity} × ` : ""}${i.title}${Object.keys(i.variant).length ? ` (${Object.entries(i.variant).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}`).join("; "),
    amount: formatMoney(o.amountCents, o.currency),
    amountCents: o.amountCents,
    status: STATUS[o.status],
    delivery: o.tracking ? `${o.tracking.status}, ${o.tracking.carrier}, arriving ${o.tracking.eta}` : o.status === "captured" ? "Not shipped yet" : "",
  }));
  const actionable: ActionableOrder[] = orders
    .filter((o) => (o.status === "held" && o.undoUntil && o.undoUntil.getTime() > Date.now()) || o.status === "captured")
    .map((o) => {
      const what = `${o.items.map((i) => i.title).join(" and ")} from ${o.storeName}, ${formatMoney(o.amountCents, o.currency)}`;
      return o.status === "held"
        ? { id: o.id, kind: "held", label: `${what}. On hold until ${o.undoUntil!.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}; nothing is charged if you cancel.` }
        : { id: o.id, kind: "paid", label: `${what}. Paid. You can return it.` };
    });
  const left = account.rules ? Math.max(0, account.rules.monthlyCents - summary.totalCents) : null;

  return (
    <>
      <div className="page-intro">
        <h1>My orders</h1>
        <p>Use the arrow keys to move through the table. Each cell is read with its column name.</p>
      </div>
      <ul className="summary-row" aria-label="This month">
        <li>
          Spent this month <strong>{formatMoney(summary.totalCents)}</strong>
        </li>
        {left !== null && (
          <li>
            Left this month <strong>{formatMoney(left)}</strong>
          </li>
        )}
        <li>
          Orders <strong>{orders.length}</strong>
        </li>
      </ul>
      <OrderActions orders={actionable} />
      {rows.length === 0 ? (
        <p>No orders yet. Ask Open Aisle for something on the Shop page.</p>
      ) : (
        <>
          <h2 style={{ marginTop: "2rem" }}>All orders</h2>
          <OrdersGrid rows={rows} />
        </>
      )}
    </>
  );
}
