"use client";
/**
 * The fix form for one barrier, shared by the barrier report and the fix board.
 *
 * A plain form, not editing inside a grid cell or a card, so it works the same
 * for keyboard and screen-reader users on the store side. Focus moves to its
 * heading when it opens, so the merchant hears which barrier they're fixing.
 */
import { useEffect, useRef, useState } from "react";
import { barrierApi, KIND_LABEL, STATUS_LABEL, type Barrier } from "./barriers";

export function FixPanel(props: { barrier: Barrier; storeId: string; onDone: (message: string) => void; onClose: () => void }) {
  const { barrier: b, storeId } = props;
  const [fix, setFix] = useState(b.suggestedFix ?? "");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<"draft" | "apply" | "status" | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    setFix(b.suggestedFix ?? "");
    setNote(null);
    setError(null);
    heading.current?.focus();
  }, [b.id, b.suggestedFix]);

  async function draft() {
    setWorking("draft");
    setError(null);
    const d = await barrierApi.draft(b.id);
    setWorking(null);
    if (!d.ok) return setError(d.error);
    setFix(d.draft.text);
    setNote(d.draft.note);
  }

  async function apply() {
    setWorking("apply");
    setError(null);
    const d = await barrierApi.fix(storeId, b.id, fix);
    setWorking(null);
    if (!d.ok) return setError(d.error);
    props.onDone(d.message);
  }

  async function move(status: "open" | "in_progress" | "dismissed") {
    setWorking("status");
    const d = await barrierApi.setStatus(storeId, b.id, status);
    setWorking(null);
    if (!d.ok) return setError(d.error);
    props.onDone(d.message);
  }

  const blanks = fix.includes("__");

  return (
    <section aria-labelledby="fix-title" className="panel fix-panel">
      <h2 id="fix-title" ref={heading} tabIndex={-1}>
        Fix: {KIND_LABEL[b.kind] ?? b.kind}, {b.productTitle}
      </h2>
      <p>
        {b.detail}. {b.timesHit} {b.timesHit === 1 ? "shopper has" : "shoppers have"} needed this so far. Status: {STATUS_LABEL[b.status]}.
      </p>
      {error && (
        <p role="alert" className="notice notice--error">
          {error}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <label htmlFor="fix">What shoppers should hear</label>
        <p className="hint" id="fix-note">
          {note ?? "Write it the way you'd say it to a customer on the phone."}
          {blanks ? " Fill in every blank (__) before accepting." : ""}
        </p>
        <textarea id="fix" rows={4} value={fix} onChange={(e) => setFix(e.target.value)} aria-describedby="fix-note" />
        <div className="btn-row" style={{ marginTop: "1rem" }}>
          <button type="button" className="btn" onClick={draft} disabled={working !== null}>
            {working === "draft" ? "Drafting…" : "Draft it for me"}
          </button>
          <button type="submit" className="btn btn--primary" disabled={working !== null || fix.trim().length < 3 || blanks}>
            {working === "apply" ? "Saving…" : "Accept fix"}
          </button>
        </div>
      </form>
      <div className="btn-row" style={{ marginTop: "1rem" }} role="group" aria-label="Move this barrier">
        {b.status !== "fixed" && b.status !== "in_progress" && (
          <button type="button" className="btn" onClick={() => move("in_progress")} disabled={working !== null}>
            Mark as being fixed
          </button>
        )}
        {b.status !== "fixed" && b.status !== "open" && (
          <button type="button" className="btn" onClick={() => move("open")} disabled={working !== null}>
            Back to needs a fix
          </button>
        )}
        {b.status !== "fixed" && b.status !== "dismissed" && (
          <button type="button" className="btn" onClick={() => move("dismissed")} disabled={working !== null}>
            Not needed
          </button>
        )}
        <button type="button" className="btn" onClick={props.onClose}>
          Close
        </button>
      </div>
    </section>
  );
}
