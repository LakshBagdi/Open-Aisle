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
 *  - "Answer by voice" works inside the dialog (the rest of the page is
 *    blocked while it's open), so voice users can say "confirm" here.
 */
import { useEffect, useRef } from "react";
import { ui, type Lang } from "./uiText";

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
  lang?: Lang;
  canTalk?: boolean;
  listening?: boolean;
  onTalk?: () => void;
  onConfirm: () => void;
  onChange: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const { data } = props;
  const lang = props.lang ?? "en";

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
            <h2 id="readback-title">{ui(lang, "rbTitle")}</h2>
          </div>
          <div className="readback__body">
            <div id="readback-body">
              <p>{ui(lang, "rbFrom", { store: data.storeName })}</p>
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
                  {ui(lang, "rbBack")}
                </button>
              ) : (
                <>
                  <button type="button" className="btn btn--primary" onClick={props.onConfirm} disabled={props.busy} aria-describedby={props.canTalk ? "readback-voice-hint" : undefined}>
                    {props.busy ? ui(lang, "rbPlacing") : ui(lang, "rbConfirm", { total })}
                  </button>
                  <button type="button" className="btn" onClick={props.onChange} disabled={props.busy}>
                    {ui(lang, "rbChange")}
                  </button>
                  <button type="button" className="btn btn--danger" onClick={props.onCancel} disabled={props.busy}>
                    {ui(lang, "rbDont")}
                  </button>
                </>
              )}
            </div>
            {!data.blockedReason && props.canTalk && props.onTalk && (
              <div className="readback__voice">
                <button type="button" className="btn talk-btn" aria-pressed={Boolean(props.listening)} onClick={props.onTalk} disabled={props.busy}>
                  {props.listening ? ui(lang, "rbVoiceListening") : ui(lang, "rbVoice")}
                </button>
                <p id="readback-voice-hint" className="hint">
                  {ui(lang, "rbVoiceHint")}
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </dialog>
  );
}
