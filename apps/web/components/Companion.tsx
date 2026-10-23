"use client";
/**
 * The shopping companion.
 *
 * Voice first, screen-reader safe:
 *  - One big talk button, also on the Space key from anywhere on the page.
 *    A rising tone means "listening", a falling tone means "stopped".
 *  - If you speak, Open Aisle speaks back, then listens again, so a whole
 *    purchase can happen without touching the screen. Silence ends it.
 *  - If you type, replies go to a polite live region instead, so a screen
 *    reader reads them and two voices never talk over each other (unless
 *    "Read replies aloud" is on).
 *  - The conversation is a list; each turn has a heading ("You said",
 *    "Open Aisle said") so people can jump turn to turn with the H key.
 *
 * Money moves only through the read-back dialog's Confirm (see ReadBackDialog).
 */
import { isConfirmPhrase, type Lang } from "@open-aisle/core/i18n";
import type { ShownProduct } from "@open-aisle/core/agent";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProductCards } from "./ProductCards";
import { ReadBackDialog, type ReadBackData } from "./ReadBackDialog";
import { useSpeech } from "./useSpeech";

type Turn = { id: string; kind: "you" | "agent" | "note" | "error"; text: string; products?: ShownProduct[] };
type Modes = { screenReader: boolean; voice: boolean; plainWords: boolean; largeText: boolean };
type AgentEvent =
  | ({ type: "readback" } & ReadBackData)
  | { type: "cart_updated"; cartId: string; itemCount: number; total: string }
  | { type: "order_cancelled"; orderId: string }
  | { type: "products"; items: ShownProduct[] };
type Undo = { orderId: string; until: number; total: number };

const HEADINGS = { you: "You said", agent: "Open Aisle said", note: "Update", error: "Problem" } as const;
const CONV_KEY = "open-aisle:conversation";
const PREFS_KEY = "open-aisle:voice-prefs";
const SUGGESTIONS = ["Black running shoes, size 9, under 60 dollars", "A kitchen scale that talks", "Where's my last order?", "How much have I spent this month?"];
const STOP_WORDS = /^(no|stop|cancel|don'?t|do not)( order| it| that)?[.!]*$/i;

function session(key: string, value?: string | null) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage can be blocked; the app still works */
  }
  return null;
}
function loadPrefs(): { readAloud?: boolean; handsFree?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function savePrefs(p: { readAloud: boolean; handsFree: boolean }) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* fine: preference lasts for this visit only */
  }
}

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Space talks, unless the person is typing or on a control that uses Space itself. */
function spaceIsFree(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return true;
  if (target.isContentEditable) return false;
  return !target.closest("input, textarea, select, button, a, summary, [role='button'], [role='checkbox'], [role='grid'], [role='gridcell']");
}

let counter = 0;
const nextId = () => `t${Date.now()}-${counter++}`;

export function Companion(props: { name: string; lang: Lang; modes: Modes; paypalConnected: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [caption, setCaption] = useState("");
  const [announce, setAnnounce] = useState("");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [readback, setReadback] = useState<ReadBackData | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [cart, setCart] = useState<{ itemCount: number; total: string } | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [readAloud, setReadAloud] = useState(props.modes.voice);
  const [handsFree, setHandsFree] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const warnedOneMinute = useRef(false);
  /** True while the conversation is happening by voice: replies are spoken, then we listen again. */
  const voiceTurn = useRef(false);
  const speech = useSpeech(props.lang);

  // Latest values for callbacks that fire later (after speech ends, from key presses).
  const live = useRef({ readback, busy, handsFree, readAloud, confirming });
  live.current = { readback, busy, handsFree, readAloud, confirming };

  useEffect(() => {
    const p = loadPrefs();
    if (typeof p.readAloud === "boolean") setReadAloud(p.readAloud || props.modes.voice);
    if (typeof p.handsFree === "boolean") setHandsFree(p.handsFree);
  }, [props.modes.voice]);
  useEffect(() => savePrefs({ readAloud, handsFree }), [readAloud, handsFree]);

  const add = useCallback((kind: Turn["kind"], t: string, products?: ShownProduct[]) => setTurns((prev) => [...prev, { id: nextId(), kind, text: t, products }]), []);

  // Keep the newest turn in view, above the dock that floats over the bottom of the page.
  useEffect(() => {
    const end = endRef.current;
    if (!end || turns.length === 0) return;
    const dock = document.querySelector<HTMLElement>(".dock");
    end.style.scrollMarginBottom = `${(dock?.offsetHeight ?? 0) + 24}px`;
    end.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, busy]);

  const listenRef = useRef<(auto: boolean) => void>(() => {});

  /**
   * Say something. Spoken when the person is talking to us (or asked for
   * spoken replies); otherwise sent to the live region for their screen reader.
   * After speaking in a voice conversation, listen again.
   */
  const say = useCallback(
    (message: string, opts: { listenAfter?: boolean } = {}) => {
      if (voiceTurn.current || live.current.readAloud) {
        speech.speak(message, () => {
          if (opts.listenAfter && voiceTurn.current && live.current.handsFree) listenRef.current(true);
        });
      } else {
        setAnnounce("");
        // A new string each time so screen readers announce repeats too.
        setTimeout(() => setAnnounce(message), 50);
      }
    },
    [speech],
  );

  // Restore the conversation after a reload.
  useEffect(() => {
    const id = session(CONV_KEY);
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
          // The read-back speaks for itself; then, in a voice conversation, we listen for "confirm".
          if (voiceTurn.current || live.current.readAloud) say(e.blockedReason ? e.blockedReason : `${e.spoken} Say "confirm" to pay, or "change" to change something.`, { listenAfter: !e.blockedReason });
        }
      }
    },
    [say],
  );

  const send = useCallback(
    async (message: string, how: "typed" | "voice" = "typed") => {
      const clean = message.trim();
      if (!clean || live.current.busy) return;
      voiceTurn.current = how === "voice";
      speech.silence();
      add("you", clean);
      setText("");
      setCaption("");
      setBusy(true);
      setStatus("Thinking…");
      if (how === "typed") setAnnounce("Looking.");
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean, conversationId }) });
        const d = await res.json().catch(() => ({ ok: false, error: "Open Aisle didn't answer properly. Please try again." }));
        if (!d.ok) throw new Error(d.error);
        if (d.conversationId !== conversationId) {
          setConversationId(d.conversationId);
          session(CONV_KEY, d.conversationId);
        }
        const events: AgentEvent[] = d.events ?? [];
        const products = events.flatMap((e) => (e.type === "products" ? e.items : []));
        add("agent", d.reply, products.length ? products : undefined);
        const hasReadback = events.some((e) => e.type === "readback");
        // The dialog reads itself; don't talk over it.
        if (!hasReadback || !(voiceTurn.current || live.current.readAloud)) say(d.reply, { listenAfter: true });
        handleEvents(events);
      } catch (err) {
        const msg = err instanceof Error && err.message ? err.message : "I couldn't reach Open Aisle. Check your connection and try again.";
        add("error", msg);
        say(msg);
      } finally {
        setBusy(false);
        setStatus("");
        if (how === "typed") inputRef.current?.focus();
      }
    },
    [conversationId, add, handleEvents, say, speech],
  );

  const confirm = useCallback(async () => {
    const rb = live.current.readback;
    if (!rb || live.current.confirming) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const res = await fetch("/api/orders/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cartId: rb.cartId, fingerprint: rb.fingerprint }) });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setReadback(null);
      setCart(null);
      warnedOneMinute.current = false;
      if (d.undoUntil) {
        const until = new Date(d.undoUntil).getTime();
        setNow(Date.now());
        setUndo({ orderId: d.orderId, until, total: until - Date.now() });
      }
      add("note", d.message);
      say(d.message);
      inputRef.current?.focus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "The order wasn't placed. Nothing was charged.";
      setConfirmError(msg);
      if (voiceTurn.current || live.current.readAloud) speech.speak(msg);
    } finally {
      setConfirming(false);
    }
  }, [add, say, speech]);

  const closeReadback = useCallback(
    (why: "change" | "dont") => {
      setReadback(null);
      const msg = why === "change" ? "Okay. Tell me what to change." : "Okay, I won't order it. Your cart is still there.";
      add("note", msg);
      say(msg, { listenAfter: why === "change" });
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

  /** Open the microphone. auto = we're continuing a voice conversation, so silence just ends it quietly. */
  const startListening = useCallback(
    (auto: boolean) => {
      if (live.current.busy) return;
      setStatus("");
      speech.listen({
        onInterim: setCaption,
        onFinal: (heard) => {
          setCaption("");
          const rb = live.current.readback;
          // While the read-back is open, "confirm" means press Confirm.
          if (rb && !rb.blockedReason && isConfirmPhrase(heard, props.lang)) {
            voiceTurn.current = true;
            add("you", heard);
            void confirm();
            return;
          }
          if (rb && STOP_WORDS.test(heard.trim())) {
            voiceTurn.current = true;
            add("you", heard);
            closeReadback("dont");
            return;
          }
          if (rb) setReadback(null);
          void send(heard, "voice");
        },
        onError: (code, message) => {
          setCaption("");
          if (auto && code === "no-speech") {
            voiceTurn.current = false;
            setStatus("Press Space or the yellow button when you want to talk again.");
            return;
          }
          setStatus(message);
          if (code !== "no-speech") {
            voiceTurn.current = true;
            say(message);
          }
        },
      });
    },
    [speech, props.lang, add, confirm, closeReadback, send, say],
  );
  listenRef.current = startListening;

  /** The talk button: one control for talk, stop listening and stop talking. */
  const talk = useCallback(() => {
    if (speech.listening) return speech.stop();
    if (speech.speaking) {
      speech.silence();
      return startListening(false);
    }
    startListening(false);
  }, [speech, startListening]);

  // Space to talk from anywhere; Escape stops listening or talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && spaceIsFree(e.target) && !live.current.readback) {
        e.preventDefault();
        talk();
      } else if (e.key === "Escape" && !live.current.readback && (speech.listening || speech.speaking)) {
        e.preventDefault();
        if (speech.listening) speech.stop();
        speech.silence();
        voiceTurn.current = false;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [talk, speech]);

  const left = undo ? undo.until - now : 0;
  const mode = speech.listening ? "listening" : busy ? "thinking" : speech.speaking ? "speaking" : "idle";
  const talkLabel = {
    listening: "Listening. Press to stop",
    thinking: "Thinking",
    speaking: "Speaking. Press to interrupt and talk",
    idle: "Talk",
  }[mode];
  const dockLine = caption ? `“${caption}”` : status || (mode === "speaking" ? "Speaking… press the button or Escape to stop." : mode === "listening" ? "Listening…" : "");

  return (
    <div className="companion">
      <section className="convo" aria-labelledby="chat-title">
        <header className="convo__hello">
          <h1 id="chat-title">
            Hi {props.name}.<span className="convo__ask"> What can I find for you?</span>
          </h1>
          {turns.length === 0 && <p className="convo__lede">Say it or type it, in your own words. I tell you only what the store&apos;s data says, and I never pay without your clear yes.</p>}
        </header>

        {!props.paypalConnected && (
          <p className="notice notice--warn">
            PayPal isn&apos;t connected yet, so I can find things but can&apos;t order them. <a href="/settings#paypal">Connect PayPal in Settings</a>
          </p>
        )}

        {turns.length === 0 ? (
          <div className="starters">
            <h2 className="starters__title">Try asking</h2>
            <ul className="starters__list">
              {SUGGESTIONS.map((s) => (
                <li key={s}>
                  <button type="button" className="chip" onClick={() => void send(s)} disabled={busy}>
                    {s}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ol className="transcript" aria-label="Conversation">
            {turns.map((t) => (
              <li key={t.id} className={`turn turn--${t.kind}`}>
                <h3 className="visually-hidden">{HEADINGS[t.kind]}</h3>
                <div className="turn__bubble">
                  {t.text.split(/\n{2,}/).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
                {t.products && <ProductCards items={t.products} disabled={busy} onAsk={(q) => void send(q)} />}
              </li>
            ))}
            {busy && (
              <li className="turn turn--agent turn--pending" aria-hidden="true">
                <div className="turn__bubble">
                  <span className="dots">
                    <span />
                    <span />
                    <span />
                  </span>
                </div>
              </li>
            )}
          </ol>
        )}
        <div ref={endRef} />

        <div className="dock">
          <div className="dock__row">
            <button
              type="button"
              className={`talk talk--${mode}`}
              aria-pressed={speech.listening}
              aria-keyshortcuts="Space"
              aria-describedby="talk-hint"
              onClick={talk}
              disabled={busy}
            >
              <span className="talk__dome" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="30" height="30" focusable="false">
                  {mode === "speaking" ? (
                    <path d="M7 7h10v10H7z" fill="currentColor" />
                  ) : (
                    <path d="M12 15a3.5 3.5 0 0 0 3.5-3.5v-5a3.5 3.5 0 1 0-7 0v5A3.5 3.5 0 0 0 12 15Zm6-3.5a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.9V20H8.5a1 1 0 1 0 0 2h7a1 1 0 1 0 0-2H13v-2.6a6 6 0 0 0 5-5.9Z" fill="currentColor" />
                  )}
                </svg>
              </span>
              <span className="talk__label">{talkLabel}</span>
            </button>

            <form
              className="composer"
              onSubmit={(e) => {
                e.preventDefault();
                void send(text);
              }}
            >
              <label htmlFor="ask" className="visually-hidden">
                Your message
              </label>
              <textarea
                id="ask"
                ref={inputRef}
                rows={1}
                value={text}
                placeholder="Or type here…"
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
              <button type="submit" className="btn btn--primary composer__send" disabled={busy || !text.trim()}>
                Send
              </button>
            </form>
          </div>

          <p className="dock__caption" aria-hidden="true">
            {dockLine}
          </p>

          <div className="dock__prefs">
            <label className="toggle">
              <input type="checkbox" checked={readAloud} onChange={(e) => setReadAloud(e.target.checked)} />
              <span>Read replies aloud, even when I type</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={handsFree} onChange={(e) => setHandsFree(e.target.checked)} />
              <span>Keep listening after each reply</span>
            </label>
          </div>
          <p id="talk-hint" className="dock__hint">
            {speech.supported ? "Press Space anywhere to talk. Escape stops. " : "Voice input needs Chrome, Edge or Safari. "}
            <span id="ask-hint">In the text box, Enter sends and Shift+Enter adds a line.</span>
          </p>
        </div>

        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
      </section>

      <aside className="side" aria-label="Order status">
        {undo && left > 0 && (
          <section className="panel panel--undo" aria-labelledby="undo-title">
            <h2 id="undo-title">You can still cancel</h2>
            <p className="undo__time" aria-label={`Time left ${mmss(left)}`}>
              {mmss(left)}
            </p>
            <div className="undo__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, (left / undo.total) * 100))}%` }} />
            </div>
            <p>PayPal is holding the money, not taking it. Say &ldquo;cancel that&rdquo;, or:</p>
            <button type="button" className="btn btn--danger btn--block" onClick={cancelOrder}>
              Cancel this order
            </button>
          </section>
        )}
        <section className="panel" aria-labelledby="cart-title">
          <h2 id="cart-title">Your cart</h2>
          {cart ? (
            <>
              <p className="cart__total">{cart.total}</p>
              <p>
                {cart.itemCount} {cart.itemCount === 1 ? "item" : "items"}, with tax and delivery. I&apos;ll read the order back before anything is paid.
              </p>
              <button type="button" className="btn btn--primary btn--block" onClick={() => void send("I'd like to buy what's in my cart")} disabled={busy}>
                Review and buy
              </button>
            </>
          ) : (
            <p className="panel__empty">Empty. Ask for something and say &ldquo;add it&rdquo;.</p>
          )}
        </section>
        <section className="panel panel--quiet" aria-labelledby="promise-title">
          <h2 id="promise-title">My promises</h2>
          <ul className="promises">
            <li>I never guess. Every price and size comes from the store&apos;s data.</li>
            <li>I never pay without your clear yes to the exact order.</li>
            <li>You can cancel during the undo window. Nothing is charged until it ends.</li>
          </ul>
        </section>
      </aside>

      <ReadBackDialog data={readback} busy={confirming} error={confirmError} onConfirm={confirm} onChange={() => closeReadback("change")} onCancel={() => closeReadback("dont")} onTalk={speech.supported ? () => startListening(false) : undefined} listening={speech.listening} />
    </div>
  );
}
