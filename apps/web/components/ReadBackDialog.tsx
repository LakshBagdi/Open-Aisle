"use client";
/**
 * The read-back: the exact order, shown and read before any payment.
 *
 * Accessibility choices:
 *  - A native <dialog> opened with showModal(): focus stays inside, Escape closes.
 *  - Focus lands on the dialog itself, not the Confirm button, so the whole
 *    order is read first and a stray Enter can't pay.
 *  - aria-describedby points at the order text, so screen readers read it all.
 *  - The Confirm button says what it does and how much: "Confirm and pay $59.53".
 */
import { useEffect, useRef } from "react";

export type ReadBackData = {
  cartId: string;
  fingerprint: string;
  storeName: string;
  lines: string[];
  totalLine: string;
  deliveryLine: string;
  undoLine: string;
  spoken: string;
  blockedReason?: string;
};

export function ReadBackDialog(props: {
  data: ReadBackData | null;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onChange: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data } = props;

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (data && !d.open) {
      d.showModal();
      d.focus();
    } else if (!data && d.open) d.close();
  }, [data]);

  const total = data?.totalLine.match(/[$₹][\d,]+(\.\d{2})?/)?.[0] ?? "";

  return (
    <dialog
      ref={ref}
      className="readback"
      aria-labelledby="readback-title"
      aria-describedby="readback-body"
      tabIndex={-1}
      onCancel={(e) => {
        e.preventDefault();
        props.onChange();
      }}
    >
      {data && (
        <>
          <div className="readback__band">
            <h2 id="readback-title">Check your order</h2>
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
            {props.error && (
              <p className="blocked" role="alert">
                {props.error}
              </p>
            )}
            <div className="btn-row">
              {data.blockedReason ? (
                <button type="button" className="btn btn--primary" onClick={props.onChange}>
                  OK, go back
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn--primary" onClick={props.onConfirm} disabled={props.busy} aria-describedby="readback-voice-hint">
                    {props.busy ? "Placing order…" : `Confirm and pay ${total}`}
                  </button>
                  <button type="button" className="btn" onClick={props.onChange} disabled={props.busy}>
                    Change something
                  </button>
                  <button type="button" className="btn btn--danger" onClick={props.onCancel} disabled={props.busy}>
                    Don't order
                  </button>
                </>
              )}
            </div>
            {!data.blockedReason && (
              <p id="readback-voice-hint" className="hint" style={{ marginTop: "0.75rem" }}>
                In voice mode you can also say "confirm".
              </p>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
