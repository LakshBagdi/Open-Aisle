"use client";
/**
 * The shopping companion.
 *
 * Screen-reader first:
 *  - The conversation is a list; each turn has a heading ("You said",
 *    "Open Aisle said"), so people can jump turn to turn with the H key.
 *  - Every reply is also put in a polite live region, so it is read aloud
 *    without moving focus away from the message box.
 *  - The message box keeps focus after sending, ready for the next request.
 *
 * Money moves only through the read-back dialog's Confirm (see ReadBackDialog).
 */
import { isConfirmPhrase, type Lang } from "@open-aisle/core/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReadBackDialog, type ReadBackData } from "./ReadBackDialog";
import { useSpeech } from "./useSpeech";

type Turn = { id: string; kind: "you" | "agent" | "note" | "error"; text: string };
type Modes = { screenReader: boolean; voice: boolean; plainWords: boolean; largeText: boolean };
type AgentEvent =
  | ({ type: "readback" } & ReadBackData)
  | { type: "cart_updated"; cartId: string; itemCount: number; total: string }
  | { type: "order_cancelled"; orderId: string };
type Undo = { orderId: string; until: number };

const HEADINGS = { you: "You said", agent: "Open Aisle said", note: "Update", error: "Problem" } as const;
const CONV_KEY = "open-aisle:conversation";

function store(key: string, value?: string | null) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; the app still works */
  }
  return null;
}

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

let counter = 0;
const nextId = () => `t${Date.now()}-${counter++}`;

export function Companion(props: { name: string; lang: Lang; modes: Modes; paypalConnected: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [announce, setAnnounce] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [readback, setReadback] = useState<ReadBackData | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [cart, setCart] = useState<{ itemCount: number; total: string } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const warnedOneMinute = useRef(false);
  const speech = useSpeech(props.lang);
  const voice = props.modes.voice;

  /** Say something: spoken in voice mode, otherwise through the live region. */
  const say = useCallback(
    (message: string) => {
      if (voice) speech.speak(message);
      else {
        setAnnounce("");
        // A new string each time so screen readers announce repeats too.
        setTimeout(() => setAnnounce(message), 50);
      }
    },
    [voice, speech],
  );

  const add = useCallback((kind: Turn["kind"], t: string) => setTurns((prev) => [...prev, { id: nextId(), kind, text: t }]), []);

  // Restore the conversation after a reload.
  useEffect(() => {
    const id = store(CONV_KEY);
    if (!id) return;
    setConversationId(id);
    fetch(`/api/chat?conversationId=${encodeURIComponent(id)}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) setTurns(d.messages.map((m: { id: string; role: string; text: string }) => ({ id: m.id, kind: m.role === "user" ? "you" : "agent", text: m.text })));
      })
      .catch(() => {});
  }, []);

  // Order updates from PayPal (charged, refunded...).
  useEffect(() => {
    const poll = async () => {
      try {
        const d = await (await fetch("/api/notifications")).json();
        if (!d.ok) return;
        for (const n of d.notifications as { text: string; orderId: string | null }[]) {
          if (n.text.startsWith("Order placed")) continue; // already said when confirming
          add("note", n.text);
          say(n.text);
          setUndo((u) => (u && n.orderId === u.orderId ? null : u));
        }
      } catch {
        /* offline for a moment; try again next time */
      }
    };
    const t = setInterval(poll, 8000);
    return () => clearInterval(t);
  }, [add, say]);

  // The undo countdown.
  useEffect(() => {
    if (!undo) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [undo]);
  useEffect(() => {
    if (!undo) return;
    const left = undo.until - now;
    if (left <= 60_000 && left > 0 && !warnedOneMinute.current) {
      warnedOneMinute.current = true;
      say("One minute left to cancel your order.");
    }
  }, [now, undo, say]);

  const handleEvents = useCallback(
    (events: AgentEvent[]) => {
      for (const e of events) {
        if (e.type === "cart_updated") setCart(e.itemCount > 0 ? { itemCount: e.itemCount, total: e.total } : null);
        if (e.type === "order_cancelled") setUndo((u) => (u?.orderId === e.orderId ? null : u));
        if (e.type === "readback") {
          setConfirmError(null);
          setReadback(e);
          if (voice) speech.speak(e.blockedReason ? e.blockedReason : e.spoken);
        }
      }
    },
    [voice, speech],
  );

  const send = useCallback(
    async (message: string) => {
      const clean = message.trim();
      if (!clean || busy) return;
      add("you", clean);
      setText("");
      setBusy(true);
      setStatus("Looking…");
      setAnnounce("Looking.");
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean, conversationId }) });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error);
        if (d.conversationId !== conversationId) {
          setConversationId(d.conversationId);
          store(CONV_KEY, d.conversationId);
        }
        add("agent", d.reply);
        handleEvents(d.events ?? []);
        const hasReadback = (d.events ?? []).some((e: AgentEvent) => e.type === "readback");
        // The dialog reads itself; don't talk over it.
        if (!hasReadback || !voice) say(d.reply);
      } catch (err) {
        const msg = err instanceof Error && err.message ? err.message : "I couldn't reach Open Aisle. Check your connection and try again.";
        add("error", msg);
        say(msg);
      } finally {
        setBusy(false);
        setStatus("");
        inputRef.current?.focus();
      }
    },
    [busy, conversationId, add, handleEvents, say, voice],
  );

  const confirm = useCallback(async () => {
    if (!readback || confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/orders/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartId: readback.cartId, fingerprint: readback.fingerprint }) });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setReadback(null);
      setCart(null);
      warnedOneMinute.current = false;
      if (d.undoUntil) {
        setNow(Date.now());
        setUndo({ orderId: d.orderId, until: new Date(d.undoUntil).getTime() });
      }
      add("note", d.message);
      say(d.message);
      inputRef.current?.focus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "The order wasn't placed. Nothing was charged.";
      setConfirmError(msg);
      if (voice) speech.speak(msg);
    } finally {
      setConfirming(false);
    }
  }, [readback, confirming, add, say, voice, speech]);

  const closeReadback = useCallback(
    (why: "change" | "dont") => {
      setReadback(null);
      const msg = why === "change" ? "Okay. Tell me what to change." : "Okay, I won't order it. Your cart is still there.";
      add("note", msg);
      say(msg);
      setTimeout(() => inputRef.current?.focus(), 0);
    },
    [add, say],
  );

  const cancelOrder = useCallback(async () => {
    if (!undo) return;
    try {
      const res = await fetch(`/api/orders/${undo.orderId}/cancel`, { method: "POST" });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setUndo(null);
      add("note", d.message);
      say(d.message);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "I couldn't cancel. Please try again.";
      add("error", msg);
      say(msg);
    }
  }, [undo, add, say]);

  const talk = useCallback(() => {
    if (speech.listening) return speech.stop();
    speech.listen(
      (heard) => {
        // While the read-back is open, "confirm" means press Confirm.
        if (readback && !readback.blockedReason && isConfirmPhrase(heard, props.lang)) {
          add("you", heard);
          void confirm();
          return;
        }
        void send(heard);
      },
      (message) => {
        setStatus(message);
        say(message);
      },
    );
  }, [speech, readback, props.lang, add, confirm, send, say]);

  const left = undo ? undo.until - now : 0;

  return (
    <div className="companion">
      <section aria-labelledby="chat-title">
        <h1 id="chat-title">Hi {props.name}, what do you need?</h1>

        {!props.paypalConnected && (
          <p className="notice notice--error">
            PayPal isn't connected yet, so I can find things but can't order them. <a href="/settings#paypal">Connect PayPal in Settings</a>.
          </p>
        )}

        {turns.length === 0 ? (
          <div className="empty-intro">
            <p>Tell me in your own words. For example:</p>
            <ul>
              <li>"Black running shoes, size 9, under 60 dollars"</li>
              <li>"Is there a kitchen scale that talks?"</li>
              <li>"Where's my last order?"</li>
            </ul>
            <p>I only tell you what the store's own data says, and I never pay without your clear yes.</p>
          </div>
        ) : (
          <ol className="transcript" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} className={`turn turn--${t.kind}${t.kind === "error" ? " turn--note" : ""}`}>
                <h3>{HEADINGS[t.kind]}</h3>
                {t.text.split(/\n{2,}/).map((p, i) => (
                  <p key={i}>{p}</p>
                ))}
              </li>
            ))}
          </ol>
        )}

        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send(text);
          }}
        >
          <label htmlFor="ask">Your message</label>
          <p className="hint" id="ask-hint">
            Press Enter to send. Shift and Enter adds a new line.
          </p>
          <div className="composer__row">
            <textarea
              id="ask"
              ref={inputRef}
              rows={2}
              value={text}
              aria-describedby="ask-hint"
              autoComplete="off"
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send(text);
                }
              }}
            />
            <button type="submit" className="btn btn--primary" disabled={busy || !text.trim()}>
              Send
            </button>
            {speech.supported && (
              <button type="button" className="btn talk-btn" aria-pressed={speech.listening} onClick={talk} disabled={busy}>
                {speech.listening ? "Stop listening" : "Talk"}
              </button>
            )}
          </div>
          <p className="status-line" aria-hidden="true">
            {status}
          </p>
        </form>

        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
      </section>

      <aside className="side" aria-label="Order status">
        {undo && left > 0 && (
          <section className="panel undo" aria-labelledby="undo-title">
            <h2 id="undo-title">You can still cancel</h2>
            <p>
              Time left: <span className="undo__time">{mmss(left)}</span>
            </p>
            <p>The money is held by PayPal, not taken. Say "cancel that", or:</p>
            <button type="button" className="btn btn--danger" onClick={cancelOrder}>
              Cancel this order
            </button>
          </section>
        )}
        <section className="panel" aria-labelledby="cart-title">
          <h2 id="cart-title">Your cart</h2>
          {cart ? (
            <p>
              {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"}, {cart.total} with tax and delivery. Say "buy it" when you're ready, and I'll read it back first.
            </p>
          ) : (
            <p>Empty.</p>
          )}
        </section>
        <section className="panel" aria-labelledby="promise-title">
          <h2 id="promise-title">My promises</h2>
          <ul>
            <li>I never guess. Facts come from the store's data.</li>
            <li>I never pay without your clear yes to the exact order.</li>
            <li>You can cancel during the undo window. Nothing is charged until it ends.</li>
          </ul>
        </section>
      </aside>

      <ReadBackDialog data={readback} busy={confirming} error={confirmError} onConfirm={confirm} onChange={() => closeReadback("change")} onCancel={() => closeReadback("dont")} />
    </div>
  );
}
