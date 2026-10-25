"use client";
/**
 * Things you can still do with an order, as plain buttons (not hidden inside
 * the table): cancel one that's on hold, or return one that was paid.
 */
import { useRef, useState } from "react";

export type ActionableOrder = { id: string; label: string; kind: "held" | "paid" };

const REASONS = ["It doesn't fit", "It isn't what I expected", "It arrived damaged", "I changed my mind"];

export function OrderActions({ orders }: { orders: ActionableOrder[] }) {
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const msgRef = useRef<HTMLParagraphElement>(null);

  async function act(o: ActionableOrder) {
    setBusy(o.id);
    const url = o.kind === "held" ? `/api/orders/${o.id}/cancel` : `/api/orders/${o.id}/return`;
    const body = o.kind === "paid" ? JSON.stringify({ reason: reasons[o.id] ?? REASONS[0] }) : undefined;
    try {
      const d = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })).json();
      setMessage(d.ok ? { text: d.message } : { text: d.error, error: true });
      if (d.ok) setDone((x) => [...x, o.id]);
    } catch {
      setMessage({ text: "Couldn't reach Open Aisle. Please try again.", error: true });
    }
    setBusy(null);
    setTimeout(() => msgRef.current?.focus(), 0);
  }

  const open = orders.filter((o) => !done.includes(o.id));
  if (orders.length === 0) return null;
  return (
    <section aria-labelledby="actions-title" className="panel" style={{ maxWidth: "44rem" }}>
      <h2 id="actions-title">Things you can do</h2>
      <p ref={msgRef} tabIndex={-1} role={message?.error ? "alert" : "status"} className={message ? `notice${message.error ? " notice--error" : ""}` : "visually-hidden"}>
        {message?.text ?? ""}
      </p>
      {open.length === 0 ? (
        <p>Nothing else to do right now. The table below will update when you reload.</p>
      ) : (
        <ul className="action-list">
          {open.map((o) => (
            <li key={o.id}>
              <p style={{ margin: 0 }}>{o.label}</p>
              {o.kind === "held" ? (
                <button type="button" className="btn btn--danger" onClick={() => act(o)} disabled={busy !== null}>
                  {busy === o.id ? "Cancelling…" : "Cancel this order"}
                </button>
              ) : (
                <div className="btn-row" style={{ alignItems: "flex-end" }}>
                  <div>
                    <label htmlFor={`reason-${o.id}`}>Why are you returning it?</label>
                    <select id={`reason-${o.id}`} value={reasons[o.id] ?? REASONS[0]} onChange={(e) => setReasons((r) => ({ ...r, [o.id]: e.target.value }))}>
                      {REASONS.map((r) => (
                        <option key={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className="btn" onClick={() => act(o)} disabled={busy !== null}>
                    {busy === o.id ? "Starting…" : "Start a return"}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
