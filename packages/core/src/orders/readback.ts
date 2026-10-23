/**
 * The read-back: the exact order, spoken before any payment.
 *
 * Built by code from the cart itself, never written by the AI, so what the
 * person hears is exactly what will be paid. The same text is shown in the
 * confirm dialog and read by the screen reader.
 */
import type { Cart, Store } from "../db/schema";
import { formatMoney } from "../money";
import { t, type Lang } from "../i18n";

export type ReadBack = {
  cartId: string;
  storeName: string;
  lines: string[];
  totalLine: string;
  deliveryLine: string;
  undoLine: string;
  /** Everything in one string, for speech. */
  spoken: string;
  totalCents: number;
};

export function buildReadBack(cart: Cart, store: Store, undoWindowSeconds: number, lang: Lang = "en"): ReadBack {
  if (!cart.totals || cart.items.length === 0) throw new Error("Empty cart");
  const tot = cart.totals;
  const money = (c: number) => formatMoney(c, tot.currency);

  const lines = cart.items.map((i) => {
    const variant = Object.entries(i.variant)
      .map(([k, v]) => `${t(lang, "readback.option", { name: k })} ${v}`)
      .join(", ");
    const qty = i.quantity === 1 ? "" : `${i.quantity} × `;
    return `${qty}${i.title}${variant ? `, ${variant}` : ""}: ${money(i.unitPriceCents * i.quantity)}`;
  });

  const parts = [`${t(lang, "readback.subtotal")} ${money(tot.subtotalCents)}`, `${t(lang, "readback.tax")} ${money(tot.taxCents)}`];
  parts.push(tot.deliveryCents === 0 ? t(lang, "readback.freeDelivery") : `${t(lang, "readback.delivery")} ${money(tot.deliveryCents)}`);
  const totalLine = `${t(lang, "readback.total")} ${money(tot.totalCents)} (${parts.join(", ")}).`;
  const deliveryLine = t(lang, "readback.arrives", { date: tot.deliveryEstimate, store: store.name });
  const minutes = Math.round(undoWindowSeconds / 60);
  const undoLine = t(lang, "readback.undo", { minutes: String(minutes) });

  const spoken = [t(lang, "readback.intro", { store: store.name }), ...lines.map((l) => `${l}.`), totalLine, deliveryLine, undoLine, t(lang, "readback.ask")].join(" ");
  return { cartId: cart.id, storeName: store.name, lines, totalLine, deliveryLine, undoLine, spoken, totalCents: tot.totalCents };
}
