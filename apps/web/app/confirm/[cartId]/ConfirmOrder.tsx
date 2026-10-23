"use client";
/**
 * The read-back as a page (not a dialog), with the same rules: focus starts on
 * the order itself, the Confirm button says the amount, and after confirming
 * there's an undo button for the whole undo window.
 */
import { useEffect, useRef, useState } from "react";
import type { ReadBackData } from "@/components/ReadBackDialog";

type Placed = { orderId: string; undoUntil: string; message: string };

export function ConfirmOrder({ data }: { data: ReadBackData }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [placed, setPlaced] = useState<Placed | null>(null);
  const [cancelled, setCancelled] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const result = useRef<HTMLParagraphElement>(null);
  const total = data.totalLine.match(/[$₹][\d,]+(\.\d{2})?/)?.[0] ?? "";

  useEffect(() => heading.current?.focus(), []);
  useEffect(() => {
    if (!placed) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [placed]);

  async function confirm() {
    setBusy(true);
    setError(null);
    const d = await (await fetch("/api/orders/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartId: data.cartId, fingerprint: data.fingerprint }) })).json();
    setBusy(false);
    if (!d.ok) return setError(d.error);
    setNow(Date.now());
    setPlaced({ orderId: d.orderId, undoUntil: d.undoUntil, message: d.message });
    setTimeout(() => result.current?.focus(), 0);
  }

  async function cancel() {
    if (!placed) return;
    setBusy(true);
    const d = await (await fetch(`/api/orders/${placed.orderId}/cancel`, { method: "POST" })).json();
    setBusy(false);
    setCancelled(d.ok ? d.message : d.error);
    setTimeout(() => result.current?.focus(), 0);
  }

  if (placed) {
    const left = Math.max(0, Math.round((new Date(placed.undoUntil).getTime() - now) / 1000));
    const mm = Math.floor(left / 60);
    const ss = String(left % 60).padStart(2, "0");
    return (
      <section className="panel undo" aria-labelledby="placed-title" style={{ maxWidth: "40rem" }}>
        <h2 id="placed-title">{cancelled ? "Cancelled" : "Order placed"}</h2>
        <p ref={result} tabIndex={-1} role="status">
          {cancelled ?? placed.message}
        </p>
        {!cancelled && left > 0 && (
          <>
            <p className="undo__time" aria-hidden="true">
              {mm}:{ss}
            </p>
            <button type="button" className="btn btn--danger" onClick={cancel} disabled={busy}>
              Cancel this order ({mm} min {ss} s left)
            </button>
          </>
        )}
      </section>
    );
  }

  return (
    <section className="readback" aria-labelledby="readback-title" aria-describedby="readback-body" style={{ maxWidth: "40rem", border: "4px solid #0e2a47", borderRadius: "0.5rem" }}>
      <div className="readback__band">
        <h2 id="readback-title" ref={heading} tabIndex={-1}>
          Check your order
        </h2>
      </div>
      <div className="readback__body">
        <div id="readback-body">
          <p>From {data.storeName}:</p>
          <ul className="readback__lines">
            {data.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          <p className="readback__total">{data.totalLine}</p>
          <p>{data.deliveryLine}</p>
          {data.blockedReason ? <p className="blocked">{data.blockedReason}</p> : <p>{data.undoLine}</p>}
        </div>
        {error && (
          <p className="blocked" role="alert">
            {error}
          </p>
        )}
        {!data.blockedReason && (
          <div className="btn-row">
            <button type="button" className="btn btn--primary" onClick={confirm} disabled={busy}>
              {busy ? "Placing order…" : `Confirm and pay ${total}`}
            </button>
            <a className="btn" href="/" style={{ display: "inline-flex", alignItems: "center", textDecoration: "none" }}>
              Don't order
            </a>
          </div>
        )}
      </div>
    </section>
  );
}
