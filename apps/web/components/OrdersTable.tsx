"use client";
/**
 * Order history. On wide screens: the AG Grid table (sortable, arrow-key
 * navigation). On phones: a plain list of cards, which reads better than a
 * six-column table squeezed into a sideways-scrolling box, and doesn't
 * download the grid at all.
 */
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import type { OrderRow } from "./OrdersGrid";

const Grid = dynamic(() => import("./OrdersGrid").then((m) => m.OrdersGrid), { ssr: false });

const WIDE = "(min-width: 40.01rem)";

export function OrdersTable({ rows }: { rows: OrderRow[] }) {
  const [wide, setWide] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  if (wide) {
    return (
      <>
        <p className="hint">Use the arrow keys to move through the table.</p>
        <Grid rows={rows} />
      </>
    );
  }
  return (
    <ul className="order-cards">
      {rows.map((r) => (
        <li key={r.id} className="order-card">
          <p className="order-card__top">
            <span>{r.date}</span>
            <strong>{r.amount}</strong>
          </p>
          <p className="order-card__items">{r.items}</p>
          <p className="order-card__meta">
            {r.store} · {r.status}
            {r.delivery ? ` · ${r.delivery}` : ""}
          </p>
        </li>
      ))}
    </ul>
  );
}
