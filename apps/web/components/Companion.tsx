"use client";
/**
 * The shopping companion.
 *
 * Voice first, screen-reader safe:
 *  - First visit asks how the person wants to use it: talk and listen, their
 *    own screen reader, or read and type (changeable in Settings).
 *  - One big talk button, also on Space (when not typing or on a control) and
 *    on Alt+T from anywhere, even inside the read-back. A rising tone means
 *    "listening", a falling tone means "stopped".
 *  - If you speak, Open Aisle speaks back (unless you use a screen reader),
 *    then listens again, so a whole purchase can happen without touching the
 *    screen. Silence ends it quietly.
 *  - If you type, replies go to a polite live region, so a screen reader reads
 *    them and two voices never talk over each other (unless "Read replies
 *    aloud" is on).
 *  - The conversation is a list; each turn has a heading ("You said",
 *    "Open Aisle said") so people can jump turn to turn with the H key.
 *
 * Short commands are handled here, without the AI, so they are instant and
 * can't be misunderstood: confirm / change / don't order (while the read-back
 * is open), cancel that (inside the undo window), repeat, stop, help.
 *
 * Money moves only through the read-back dialog's Confirm (see ReadBackDialog).
 */
import { isConfirmPhrase, voiceCommand } from "@open-aisle/core/i18n";
import type { ShownProduct } from "@open-aisle/core/agent";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProductCards } from "./ProductCards";
import { ReadBackDialog, type ReadBackData } from "./ReadBackDialog";
import { ui, type Lang, type UiKey } from "./uiText";
import { useSpeech } from "./useSpeech";

type Turn = { id: string; kind: "you" | "agent" | "note" | "error"; text: string; products?: ShownProduct[] };
export type Modes = { screenReader: boolean; voice: boolean; plainWords: boolean; largeText: boolean; handsFree?: boolean; speechRate?: number; onboarded?: boolean };
type AgentEvent =
  | ({ type: "readback" } & ReadBackData)
  | { type: "cart_updated"; cartId: string; itemCount: number; total: string }
  | { type: "order_cancelled"; orderId: string }
  | { type: "products"; items: ShownProduct[] };
type Undo = { orderId: string; until: number; total: number };

const CONV_KEY = "open-aisle:conversation";
const STARTERS: UiKey[] = ["starter1", "starter2", "starter3", "starter4"];

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

async function saveModes(modes: Partial<Modes>) {
  try {
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modes }) });
  } catch {
    /* the choice still applies for this visit */
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
  return !target.closest("input, textarea, select, button, a, summary, [role='button'], [role='checkbox'], [role='grid'], [role='gridcell'], [role='dialog']");
}

/** "I found 3. Number 1: X, $5, from Y. Number 2: … Say “…”." → "I found 3. Say “…”." (the cards show the rest). */
function shortForCards(text: string) {
  return text.replace(/\s*Number \d+: [^]*?, from [^.]+\./g, "").trim();
}

let counter = 0;
const nextId = () => `t${Date.now()}-${counter++}`;

export function Companion(props: { name: string; lang: Lang; modes: Modes; paypalConnected: boolean; paypalNote?: "connected" | "cancelled" | "failed" }) {
  const lang = props.lang;
  const [modes, setModes] = useState<Modes>(props.modes);
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
  const [simple, setSimple] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const talkRef = useRef<HTMLButtonElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const warnedOneMinute = useRef(false);
  const lastReply = useRef("");
  /** True while the conversation is happening by voice: replies are spoken, then we listen again. */
  const voiceTurn = useRef(false);
  const speech = useSpeech(lang, modes.speechRate ?? 1);
  const T = useCallback((k: UiKey, v?: Record<string, string>) => ui(lang, k, v), [lang]);

  // Latest values for callbacks that fire later (after speech ends, from key presses).
  const live = useRef({ readback, busy, confirming, modes, undo });
  live.current = { readback, busy, confirming, modes, undo };
  const listenRef = useRef<(auto: boolean) => void>(() => {});

  const add = useCallback((kind: Turn["kind"], t: string, products?: ShownProduct[]) => setTurns((prev) => [...prev, { id: nextId(), kind, text: t, products }]), []);

  // Keep the newest turn in view, above the dock that floats over the bottom of the page.
  useEffect(() => {
    const end = endRef.current;
    if (!end || turns.length === 0) return;
    const dock = document.querySelector<HTMLElement>(".dock");
    end.style.scrollMarginBottom = `${(dock?.offsetHeight ?? 0) + 24}px`;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // After layout, so the newest turn really ends up above the dock.
    requestAnimationFrame(() => end.scrollIntoView({ block: "end", behavior: calm ? "auto" : "smooth" }));
  }, [turns.length, busy]);

  /**
   * Say something. Spoken when "read replies aloud" is on, or when the person
   * is talking to us (unless their screen reader speaks for them); otherwise
   * sent to the live region for their screen reader. In a voice
   * conversation, listen again afterwards (hands-free).
   */
  const say = useCallback(
    (message: string, opts: { listenAfter?: boolean } = {}) => {
      lastReply.current = message;
      const m = live.current.modes;
      const spoken = m.voice || (voiceTurn.current && !m.screenReader);
      if (spoken && speech.canSpeak) {
        speech.speak(message, () => {
          if (opts.listenAfter && voiceTurn.current && m.handsFree !== false) listenRef.current(true);
        });
      } else {
        setAnnounce("");
        // A new string each time so screen readers announce repeats too.
        setTimeout(() => setAnnounce(message), 50);
      }
    },
    [speech],
  );

  // Pick up where the person left off: conversation, held order, cart.
  useEffect(() => {
    const id = session(CONV_KEY);
    if (id) {
      setConversationId(id);
      fetch(`/api/chat?conversationId=${encodeURIComponent(id)}`)
        .then((r) => r.json())
        .then((d) => {
          if (d.ok) setTurns(d.messages.map((m: { id: string; role: string; text: string }) => ({ id: m.id, kind: m.role === "user" ? "you" : "agent", text: m.text })));
        })
        .catch(() => {});
    }
    fetch("/api/status")
      .then((r) => r.json())
      .then((d) => {
        if (!d.ok) return;
        if (d.heldOrder) {
          const until = new Date(d.heldOrder.undoUntil).getTime();
          setNow(Date.now());
          setUndo({ orderId: d.heldOrder.id, until, total: Math.max(until - Date.now(), 1) });
        }
        if (d.cart) setCart(d.cart);
      })
      .catch(() => {});
    // Voice users land on the talk button, ready to press.
    if (props.modes.voice && !props.modes.screenReader && props.modes.onboarded) setTimeout(() => talkRef.current?.focus(), 100);
  }, [props.modes]);

  // Order updates from PayPal (charged, refunded...).
  useEffect(() => {
    const poll = async () => {
      try {
        const d = await (await fetch("/api/notifications")).json();
        if (!d.ok) return;
        for (const n of d.notifications as { text: string; orderId: string | null }[]) {
          if (n.text.startsWith("Order placed") || n.text.startsWith("ऑर्डर हो गया")) continue; // already said when confirming
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
      say(T("oneMinute"));
    }
    if (left <= 0) setUndo(null);
  }, [now, undo, say, T]);

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
      setStatus(T("thinking"));
      if (how === "typed") setAnnounce(T("looking"));
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean, conversationId }) });
        const d = await res.json().catch(() => ({ ok: false, error: "Open Aisle didn't answer properly. Please try again." }));
        if (!d.ok) throw new Error(d.error);
        if (d.conversationId !== conversationId) {
          setConversationId(d.conversationId);
          session(CONV_KEY, d.conversationId);
        }
        setSimple(d.mode === "basic");
        const events: AgentEvent[] = d.events ?? [];
        const products = events.flatMap((e) => (e.type === "products" ? e.items : []));
        add("agent", d.reply, products.length ? products : undefined);
        let rb: ReadBackData | null = null;
        for (const e of events) {
          if (e.type === "cart_updated") setCart(e.itemCount > 0 ? { itemCount: e.itemCount, total: e.total } : null);
          if (e.type === "order_cancelled") setUndo((u) => (u?.orderId === e.orderId ? null : u));
          if (e.type === "readback") rb = e;
        }
        if (rb) {
          setConfirmError(null);
          setReadback(rb);
          // The read-back speaks for itself; then, in a voice conversation, we listen for "confirm".
          // rb.spoken already ends by asking for "confirm".
          say(rb.blockedReason ?? rb.spoken, { listenAfter: !rb.blockedReason });
        } else {
          say(d.reply, { listenAfter: true });
        }
      } catch (err) {
        const msg = err instanceof Error && err.message && err.message !== "Failed to fetch" ? err.message : T("connectionError");
        add("error", msg);
        say(msg);
      } finally {
        setBusy(false);
        setStatus("");
        if (how === "typed" && !live.current.readback) inputRef.current?.focus();
      }
    },
    [conversationId, add, say, speech, T],
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
        setUndo({ orderId: d.orderId, until, total: Math.max(until - Date.now(), 1) });
      }
      add("note", d.message);
      say(d.message, { listenAfter: true });
      setTimeout(() => (voiceTurn.current ? talkRef.current : inputRef.current)?.focus(), 0);
    } catch (err) {
      const msg = err instanceof Error && err.message && err.message !== "Failed to fetch" ? err.message : "The order wasn't placed. Nothing was charged.";
      setConfirmError(msg);
      say(msg);
    } finally {
      setConfirming(false);
    }
  }, [add, say]);

  const closeReadback = useCallback(
    (why: "change" | "dont") => {
      setReadback(null);
      const msg = why === "change" ? T("change") : T("dontOrder");
      add("note", msg);
      say(msg, { listenAfter: true });
      setTimeout(() => (voiceTurn.current ? talkRef.current : inputRef.current)?.focus(), 0);
    },
    [add, say, T],
  );

  const cancelOrder = useCallback(async () => {
    const u = live.current.undo;
    if (!u) return say(T("noCancel"));
    try {
      const res = await fetch(`/api/orders/${u.orderId}/cancel`, { method: "POST" });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      setUndo(null);
      add("note", d.message);
      say(d.message, { listenAfter: true });
    } catch (err) {
      const msg = err instanceof Error && err.message && err.message !== "Failed to fetch" ? err.message : T("cancelError");
      add("error", msg);
      say(msg);
    }
  }, [add, say, T]);

  /** Everything the person says or types goes through here first. */
  const handleInput = useCallback(
    (raw: string, how: "typed" | "voice") => {
      const input = raw.trim();
      if (!input) return;
      voiceTurn.current = how === "voice";
      const cmd = voiceCommand(input, lang);
      const rb = live.current.readback;

      if (cmd === "stop") {
        voiceTurn.current = false;
        return speech.silence();
      }
      if (cmd === "repeat") return say(rb ? rb.spoken : lastReply.current || T("nothingToRepeat"), { listenAfter: true });

      if (rb) {
        // While the read-back is open, only these answers make sense.
        if (!rb.blockedReason && isConfirmPhrase(input, lang)) {
          add("you", input);
          return void confirm();
        }
        if (cmd === "change") return closeReadback("change");
        if (cmd === "dont_order" || cmd === "cancel") return closeReadback("dont");
        if (rb.blockedReason) return closeReadback("change");
        return say(T("readbackHelp"), { listenAfter: true });
      }
      if (cmd === "cancel" && live.current.undo) {
        add("you", input);
        return void cancelOrder();
      }
      if (cmd === "help") {
        add("you", input);
        add("agent", T("help"));
        return say(T("help"), { listenAfter: true });
      }
      void send(input, how);
    },
    [lang, speech, say, add, confirm, closeReadback, cancelOrder, send, T],
  );

  /** Open the microphone. auto = we're continuing a voice conversation, so silence just ends it quietly. */
  const startListening = useCallback(
    (auto: boolean) => {
      if (live.current.busy) return;
      setStatus("");
      speech.listen({
        onInterim: setCaption,
        onFinal: (heard) => {
          setCaption("");
          handleInput(heard, "voice");
        },
        onError: (code, message) => {
          setCaption("");
          if (auto && code === "no-speech") {
            voiceTurn.current = false;
            setStatus(T("talkAgain"));
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
    [speech, handleInput, say, T],
  );
  listenRef.current = startListening;

  /** The talk button: one control for talk, stop listening and stop talking. */
  const talk = useCallback(() => {
    if (speech.listening) return speech.stop();
    if (speech.speaking) speech.silence();
    startListening(false);
  }, [speech, startListening]);

  // Space to talk from anywhere it's free; Alt+T from anywhere at all (even in
  // the text box or the read-back); Escape stops listening or talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const altT = e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT";
      const space = e.key === " " && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && spaceIsFree(e.target) && !live.current.readback && !live.current.modes.screenReader; // screen readers pass Space through while reading
      if (altT || space) {
        e.preventDefault();
        talk();
      } else if (e.key === "Escape" && (speech.listening || speech.speaking)) {
        if (!live.current.readback) e.preventDefault();
        if (speech.listening) speech.stop();
        speech.silence();
        voiceTurn.current = false;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [talk, speech]);

  const updateModes = useCallback((patch: Partial<Modes>) => {
    setModes((m) => ({ ...m, ...patch }));
    void saveModes(patch);
  }, []);

  const choose = useCallback(
    (how: "voice" | "reader" | "type") => {
      const patch: Partial<Modes> =
        how === "voice" ? { voice: true, screenReader: false, handsFree: true, onboarded: true } : how === "reader" ? { voice: false, screenReader: true, onboarded: true } : { voice: false, screenReader: false, onboarded: true };
      updateModes(patch);
      // Move focus right away (the chooser is about to disappear), so the first keys typed aren't lost.
      if (how === "voice") {
        talkRef.current?.focus();
        speech.speak(T("voiceWelcome"));
      } else inputRef.current?.focus();
    },
    [updateModes, speech, T],
  );

  /** One click from the Shop: PayPal's approval page, then straight back here. */
  const connectPayPal = useCallback(async () => {
    setConnecting(true);
    try {
      const d = await (await fetch("/api/paypal/connect", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from: "shop" }) })).json();
      if (!d.ok) throw new Error(d.error);
      window.location.assign(d.approveUrl);
    } catch (err) {
      setConnecting(false);
      say(err instanceof Error && err.message ? err.message : T("paypalFailed"));
    }
  }, [say, T]);

  const newConversation = useCallback(() => {
    session(CONV_KEY, null);
    setConversationId(undefined);
    setTurns([]);
    setSimple(false);
    say(T("newConversationDone"));
    inputRef.current?.focus();
  }, [say, T]);

  const left = undo ? undo.until - now : 0;
  const mode = speech.listening ? "listening" : busy ? "thinking" : speech.speaking ? "speaking" : "idle";
  const talkLabel = { listening: T("talkListening"), thinking: T("talkThinking"), speaking: T("talkSpeaking"), idle: T("talk") }[mode];
  const dockLine = caption ? `“${caption}”` : status || (mode === "speaking" ? T("dockSpeaking") : mode === "listening" ? T("listening") : "");

  return (
    <div className="companion">
      <section className="convo" aria-labelledby="chat-title">
        <header className="convo__hello">
          <h1 id="chat-title">
            {T("greetHi", { name: props.name })}
            <span className="convo__ask">{T("greetAsk")}</span>
          </h1>
          {turns.length === 0 && modes.onboarded && <p className="convo__lede">{T("lede")}</p>}
        </header>

        {!modes.onboarded && (
          <section className="panel choose" aria-labelledby="choose-title">
            <h2 id="choose-title">{T("chooseTitle")}</h2>
            <p className="hint">{T("chooseText")}</p>
            <div className="choose__options">
              <button type="button" className="btn choose__btn" onClick={() => choose("voice")}>
                <span className="choose__label">{T("chooseVoice")}</span>
                <span className="choose__hint">{T("chooseVoiceHint")}</span>
              </button>
              <button type="button" className="btn choose__btn" onClick={() => choose("reader")}>
                <span className="choose__label">{T("chooseReader")}</span>
                <span className="choose__hint">{T("chooseReaderHint")}</span>
              </button>
              <button type="button" className="btn choose__btn" onClick={() => choose("type")}>
                <span className="choose__label">{T("chooseType")}</span>
                <span className="choose__hint">{T("chooseTypeHint")}</span>
              </button>
            </div>
          </section>
        )}

        {props.paypalNote === "connected" && props.paypalConnected && (
          <p className="notice" role="status">
            {T("paypalConnected")}
          </p>
        )}
        {!props.paypalConnected && (
          <div className="notice notice--warn notice--action">
            <p>{props.paypalNote === "failed" ? T("paypalFailed") : T("paypalMissing")}</p>
            <button type="button" className="btn btn--primary" onClick={() => void connectPayPal()} disabled={connecting}>
              {connecting ? T("paypalOpening") : T("paypalConnect")}
            </button>
          </div>
        )}

        {simple && (
          <section className="notice" aria-labelledby="simple-title">
            <h2 id="simple-title" className="notice__title">
              {T("simpleTitle")}
            </h2>
            <p>{T("simpleText")}</p>
          </section>
        )}

        {turns.length === 0 ? (
          // On a first visit the "how would you like to use it" question comes first, on its own.
          modes.onboarded && (
            <div className="starters">
              <h2 className="starters__title">{T("tryAsking")}</h2>
              <ul className="starters__list">
                {STARTERS.map((k) => (
                  <li key={k}>
                    <button type="button" className="chip" onClick={() => handleInput(T(k), "typed")} disabled={busy}>
                      {T(k)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : (
          <ol className="transcript" aria-label={T("conversation")}>
            {turns.map((t) => (
              <li key={t.id} className={`turn turn--${t.kind}`}>
                <h3 className="visually-hidden">{T(t.kind)}</h3>
                <div className="turn__bubble">
                  {t.products && shortForCards(t.text) !== t.text ? (
                    <>
                      {/* The cards below show each product; on screen the list isn't repeated, but screen readers still hear it all. */}
                      <p aria-hidden="true">{shortForCards(t.text)}</p>
                      <p className="visually-hidden">{t.text}</p>
                    </>
                  ) : (
                    t.text.split(/\n{2,}/).map((p, i) => <p key={i}>{p}</p>)
                  )}
                </div>
                {t.products && <ProductCards items={t.products} disabled={busy} onAsk={(q) => handleInput(q, "typed")} />}
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

        <div className={`dock${turns.length > 0 ? " dock--floating" : ""}`}>
          <div className="dock__row">
            <button
              ref={talkRef}
              type="button"
              className={`talk talk--${mode}`}
              aria-pressed={speech.listening}
              aria-keyshortcuts={modes.screenReader ? "Alt+T" : "Space Alt+T"}
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
                handleInput(text, "typed");
                setText("");
              }}
            >
              <label htmlFor="ask" className="visually-hidden">
                {T("messageLabel")}
              </label>
              <textarea
                id="ask"
                ref={inputRef}
                rows={1}
                value={text}
                placeholder={T("placeholder")}
                aria-describedby="ask-hint"
                autoComplete="off"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleInput(text, "typed");
                    setText("");
                  }
                }}
              />
              <button type="submit" className="btn btn--primary composer__send" disabled={busy || !text.trim()}>
                {T("send")}
              </button>
            </form>
          </div>

          <p className="dock__caption" aria-hidden="true">
            {dockLine}
          </p>

          <div className="dock__prefs">
            {speech.canSpeak && (
              <label className="toggle">
                <input type="checkbox" checked={modes.voice} onChange={(e) => updateModes({ voice: e.target.checked })} />
                <span>{T("readAloudToggle")}</span>
              </label>
            )}
            {turns.length > 0 && (
              <button type="button" className="btn btn--quiet" onClick={newConversation}>
                {T("newConversation")}
              </button>
            )}
          </div>
          <p id="talk-hint" className="dock__hint">
            {speech.supported ? T(modes.screenReader ? "keysHintReader" : "keysHint") : T("noVoiceHint")} <span id="ask-hint">{T("messageHint")}</span>
          </p>
        </div>

        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
      </section>

      <aside className="side" aria-label={T("side")}>
        {undo && left > 0 && (
          <section className="panel panel--undo" aria-labelledby="undo-title">
            <h2 id="undo-title">{T("undoTitle")}</h2>
            <p className="undo__time" aria-label={`${T("timeLeft")} ${mmss(left)}`}>
              {mmss(left)}
            </p>
            <div className="undo__bar" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, (left / undo.total) * 100))}%` }} />
            </div>
            <p>{T("undoHeld")}</p>
            <button type="button" className="btn btn--danger btn--block" onClick={() => void cancelOrder()}>
              {T("cancelOrder")}
            </button>
          </section>
        )}
        <section className="panel" aria-labelledby="cart-title">
          <h2 id="cart-title">{T("cartTitle")}</h2>
          {cart ? (
            <>
              <p className="cart__total">{cart.total}</p>
              <p>{T("cartItems", { count: `${cart.itemCount} ${cart.itemCount === 1 ? T("item") : T("items")}` })}</p>
              <button type="button" className="btn btn--primary btn--block" onClick={() => handleInput("buy it", "typed")} disabled={busy}>
                {T("reviewBuy")}
              </button>
            </>
          ) : (
            <p className="panel__empty">{T("cartEmptyHint")}</p>
          )}
        </section>
        <section className="panel panel--quiet" aria-labelledby="promise-title">
          <h2 id="promise-title">{T("promisesTitle")}</h2>
          <ul className="promises">
            <li>{T("promise1")}</li>
            <li>{T("promise2")}</li>
            <li>{T("promise3")}</li>
          </ul>
        </section>
      </aside>

      <ReadBackDialog
        data={readback}
        busy={confirming}
        error={confirmError}
        lang={lang}
        canTalk={speech.supported}
        listening={speech.listening}
        onTalk={() => startListening(false)}
        onConfirm={() => void confirm()}
        onChange={() => closeReadback("change")}
        onCancel={() => closeReadback("dont")}
      />
    </div>
  );
}
