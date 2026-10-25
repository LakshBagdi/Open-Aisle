"use client";
/**
 * The shopping companion.
 *
 * Three ways to use it, chosen on first visit (and in Settings):
 *  - Talk and listen: press Talk (or Alt+T anywhere), speak, hear the reply.
 *    Hands-free mode listens again after every reply, so a whole purchase
 *    needs no buttons: ask, hear, "add it", "buy it", "confirm", "cancel that".
 *  - Screen reader: replies go to a polite live region so the person's own
 *    screen reader reads them; Open Aisle stays quiet to avoid two voices.
 *  - Read and type: large clear text, Enter to send.
 * Even with spoken replies off, if you SPEAK a request we answer out loud
 * (unless you use a screen reader), because you're clearly using your voice.
 *
 * Short commands are handled here, without the AI, so they are instant and
 * can't be misunderstood: confirm / change / don't order (while the read-back
 * is open), cancel that (inside the undo window), repeat, stop, help.
 *
 * Money moves only through the read-back's Confirm (see ReadBackDialog).
 */
import { isConfirmPhrase, voiceCommand } from "@open-aisle/core/i18n";
import { useCallback, useEffect, useRef, useState } from "react";
import { ReadBackDialog, type ReadBackData } from "./ReadBackDialog";
import { ui, type Lang } from "./uiText";
import { useSpeech } from "./useSpeech";

type Turn = { id: string; kind: "you" | "agent" | "note" | "error"; text: string };
export type Modes = { screenReader: boolean; voice: boolean; plainWords: boolean; largeText: boolean; handsFree?: boolean; speechRate?: number; onboarded?: boolean };
type AgentEvent =
  | ({ type: "readback" } & ReadBackData)
  | { type: "cart_updated"; cartId: string; itemCount: number; total: string }
  | { type: "order_cancelled"; orderId: string };
type Undo = { orderId: string; until: number };

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

async function saveModes(modes: Partial<Modes>) {
  try {
    await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ modes }) });
  } catch {
    /* the choice still applies for this visit */
  }
}

export function Companion(props: { name: string; lang: Lang; modes: Modes; paypalConnected: boolean }) {
  const lang = props.lang;
  const [modes, setModes] = useState<Modes>(props.modes);
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
  const [simple, setSimple] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const talkRef = useRef<HTMLButtonElement>(null);
  const warnedOneMinute = useRef(false);
  const lastReply = useRef("");
  const speech = useSpeech(lang, modes.speechRate ?? 1);
  const T = useCallback((k: Parameters<typeof ui>[1], v?: Record<string, string>) => ui(lang, k, v), [lang]);

  // Refs so callbacks always see the latest values (voice callbacks fire later).
  const modesRef = useRef(modes);
  modesRef.current = modes;
  const readbackRef = useRef(readback);
  readbackRef.current = readback;
  const undoRef = useRef(undo);
  undoRef.current = undo;
  const listenRef = useRef<() => void>(() => {});

  /**
   * Say something. Spoken when replies are on, or when the person just used
   * their voice (unless they use a screen reader, which speaks for itself).
   * `listenAfter` keeps a hands-free conversation going.
   */
  const say = useCallback(
    (message: string, o: { fromVoice?: boolean; listenAfter?: boolean } = {}) => {
      lastReply.current = message;
      const m = modesRef.current;
      const spoken = m.voice || (o.fromVoice && !m.screenReader);
      if (spoken && speech.canSpeak) {
        speech.speak(message, () => {
          if (o.listenAfter && m.handsFree) listenRef.current();
        });
      } else {
        setAnnounce("");
        // A new string each time so screen readers announce repeats too.
        setTimeout(() => setAnnounce(message), 50);
      }
    },
    [speech],
  );

  const add = useCallback((kind: Turn["kind"], t: string) => setTurns((prev) => [...prev, { id: nextId(), kind, text: t }]), []);

  // Pick up where the person left off: conversation, held order, cart.
  useEffect(() => {
    const id = store(CONV_KEY);
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
          setNow(Date.now());
          setUndo({ orderId: d.heldOrder.id, until: new Date(d.heldOrder.undoUntil).getTime() });
        }
        if (d.cart) setCart(d.cart);
      })
      .catch(() => {});
    // Voice users land on the Talk button, ready to press.
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
    async (message: string, fromVoice = false) => {
      const clean = message.trim();
      if (!clean || busy) return;
      add("you", clean);
      setText("");
      setBusy(true);
      setStatus(T("looking"));
      if (!modesRef.current.voice) setAnnounce(T("looking"));
      try {
        const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: clean, conversationId }) });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error);
        if (d.conversationId !== conversationId) {
          setConversationId(d.conversationId);
          store(CONV_KEY, d.conversationId);
        }
        setSimple(d.mode === "basic");
        add("agent", d.reply);
        let rb: ReadBackData | null = null;
        for (const e of (d.events ?? []) as AgentEvent[]) {
          if (e.type === "cart_updated") setCart(e.itemCount > 0 ? { itemCount: e.itemCount, total: e.total } : null);
          if (e.type === "order_cancelled") setUndo((u) => (u?.orderId === e.orderId ? null : u));
          if (e.type === "readback") rb = e;
        }
        if (rb) {
          setConfirmError(null);
          setReadback(rb);
          // The read-back speaks for itself (the dialog takes focus for screen readers).
          say(rb.blockedReason ?? rb.spoken, { fromVoice, listenAfter: !rb.blockedReason });
        } else {
          say(d.reply, { fromVoice, listenAfter: true });
        }
      } catch (err) {
        const msg = err instanceof Error && err.message && err.message !== "Failed to fetch" ? err.message : T("connectionError");
        add("error", msg);
        say(msg, { fromVoice });
      } finally {
        setBusy(false);
        setStatus("");
        // Keep focus where the person is working: Talk for voice, the box for typing.
        if (!readbackRef.current) (fromVoice ? talkRef.current ?? inputRef.current : inputRef.current)?.focus();
      }
    },
    [busy, conversationId, add, say, T],
  );

  const confirm = useCallback(
    async (fromVoice = false) => {
      const rb = readbackRef.current;
      if (!rb || confirming) return;
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
          setNow(Date.now());
          setUndo({ orderId: d.orderId, until: new Date(d.undoUntil).getTime() });
        }
        add("note", d.message);
        say(d.message, { fromVoice, listenAfter: true });
        setTimeout(() => (fromVoice ? talkRef.current ?? inputRef.current : inputRef.current)?.focus(), 0);
      } catch (err) {
        const msg = err instanceof Error && err.message !== "Failed to fetch" ? err.message : "The order wasn't placed. Nothing was charged.";
        setConfirmError(msg);
        say(msg, { fromVoice });
      } finally {
        setConfirming(false);
      }
    },
    [confirming, add, say],
  );

  const closeReadback = useCallback(
    (why: "change" | "dont", fromVoice = false) => {
      setReadback(null);
      const msg = why === "change" ? T("change") : T("dontOrder");
      add("note", msg);
      say(msg, { fromVoice, listenAfter: true });
      setTimeout(() => (fromVoice ? talkRef.current ?? inputRef.current : inputRef.current)?.focus(), 0);
    },
    [add, say, T],
  );

  const cancelOrder = useCallback(
    async (fromVoice = false) => {
      const u = undoRef.current;
      if (!u) {
        say(T("noCancel"), { fromVoice });
        return;
      }
      try {
        const res = await fetch(`/api/orders/${u.orderId}/cancel`, { method: "POST" });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error);
        setUndo(null);
        add("note", d.message);
        say(d.message, { fromVoice, listenAfter: true });
      } catch (err) {
        const msg = err instanceof Error && err.message !== "Failed to fetch" ? err.message : T("cancelError");
        add("error", msg);
        say(msg, { fromVoice });
      }
    },
    [add, say, T],
  );

  /** Everything the person says or types goes through here first. */
  const handleInput = useCallback(
    (raw: string, fromVoice: boolean) => {
      const input = raw.trim();
      if (!input) return;
      const cmd = voiceCommand(input, lang);
      const rb = readbackRef.current;

      if (cmd === "stop") return speech.silence();
      if (cmd === "repeat") return say(rb ? rb.spoken : lastReply.current || T("nothingToRepeat"), { fromVoice, listenAfter: true });

      if (rb) {
        // While the read-back is open, only these answers make sense.
        if (!rb.blockedReason && isConfirmPhrase(input, lang)) {
          add("you", input);
          return void confirm(fromVoice);
        }
        if (cmd === "change") return closeReadback("change", fromVoice);
        if (cmd === "dont_order" || cmd === "cancel") return closeReadback("dont", fromVoice);
        return say(T("readbackHelp"), { fromVoice, listenAfter: true });
      }
      if (cmd === "cancel" && undoRef.current) {
        add("you", input);
        return void cancelOrder(fromVoice);
      }
      if (cmd === "help") {
        add("you", input);
        add("agent", T("help"));
        return say(T("help"), { fromVoice, listenAfter: true });
      }
      void send(input, fromVoice);
    },
    [lang, speech, say, add, confirm, closeReadback, cancelOrder, send, T],
  );

  const startListening = useCallback(() => {
    if (!speech.supported) {
      say("Voice input isn't available in this browser. Try Chrome, Edge or Safari, or type instead.");
      return;
    }
    setStatus(T("listening"));
    speech.listen(
      (heard) => {
        setStatus("");
        handleInput(heard, true);
      },
      (message) => {
        setStatus(message);
        say(message, { fromVoice: true });
      },
    );
  }, [speech, say, handleInput, T]);
  listenRef.current = startListening;

  const talk = useCallback(() => {
    if (speech.listening) {
      speech.stop();
      setStatus("");
      return;
    }
    startListening();
  }, [speech, startListening]);

  // Alt+T talks from anywhere (even inside the read-back); Escape stops speech.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
        e.preventDefault();
        talk();
      } else if (e.key === "Escape" && speech.speaking) {
        speech.silence();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [talk, speech]);

  const updateModes = useCallback((patch: Partial<Modes>) => {
    setModes((m) => ({ ...m, ...patch }));
    void saveModes(patch);
  }, []);

  const choose = useCallback(
    (how: "voice" | "reader" | "type") => {
      const patch: Partial<Modes> =
        how === "voice" ? { voice: true, screenReader: false, handsFree: true, onboarded: true } : how === "reader" ? { voice: false, screenReader: true, handsFree: false, onboarded: true } : { voice: false, screenReader: false, handsFree: false, onboarded: true };
      updateModes(patch);
      if (how === "voice") {
        speech.speak(T("voiceWelcome"));
        setTimeout(() => talkRef.current?.focus(), 50);
      } else setTimeout(() => inputRef.current?.focus(), 50);
    },
    [updateModes, speech, T],
  );

  const newConversation = useCallback(() => {
    store(CONV_KEY, null);
    setConversationId(undefined);
    setTurns([]);
    setSimple(false);
    say(T("newConversationDone"));
    inputRef.current?.focus();
  }, [say, T]);

  const left = undo ? undo.until - now : 0;
  const examples = [T("example1"), T("example2"), T("example3")];

  return (
    <div className="companion">
      <section aria-labelledby="chat-title">
        <h1 id="chat-title">{T("greeting", { name: props.name })}</h1>

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

        {!props.paypalConnected && (
          <p className="notice notice--error">
            {T("paypalMissing")} <a href="/settings#paypal">{T("paypalLink")}</a>.
          </p>
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
          <div className="empty-intro">
            <p>{T("examplesIntro")}</p>
            <ul>
              {examples.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <p>{T("promiseLine")}</p>
          </div>
        ) : (
          <ol className="transcript" aria-label={T("conversation")}>
            {turns.map((t) => (
              <li key={t.id} className={`turn turn--${t.kind}${t.kind === "error" ? " turn--note turn--error" : ""}`}>
                <h3>{T(t.kind)}</h3>
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
            handleInput(text, false);
            setText("");
          }}
        >
          {speech.supported && (
            <div className="talk-row">
              <button ref={talkRef} type="button" className="btn talk-btn talk-btn--big" aria-pressed={speech.listening} aria-describedby="talk-hint" onClick={talk} disabled={busy}>
                {speech.listening ? T("stopListening") : T("talk")}
              </button>
              {speech.speaking && (
                <button type="button" className="btn" onClick={speech.silence}>
                  {T("stopTalking")}
                </button>
              )}
              <p className="hint" id="talk-hint">
                {T("shortcutHint")}
              </p>
            </div>
          )}
          <label htmlFor="ask">{T("messageLabel")}</label>
          <p className="hint" id="ask-hint">
            {T("messageHint")}
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
                  handleInput(text, false);
                  setText("");
                }
              }}
            />
            <button type="submit" className="btn btn--primary" disabled={busy || !text.trim()}>
              {T("send")}
            </button>
          </div>
          <p className="status-line" aria-hidden="true">
            {status}
          </p>
          <div className="voice-options">
            {speech.canSpeak && (
              <label className="check check--inline">
                <input type="checkbox" checked={modes.voice} onChange={(e) => updateModes({ voice: e.target.checked })} />
                <span>{T("speakReplies")}</span>
              </label>
            )}
            {speech.supported && (
              <label className="check check--inline">
                <input type="checkbox" checked={Boolean(modes.handsFree)} onChange={(e) => updateModes({ handsFree: e.target.checked })} />
                <span>{T("handsFree")}</span>
              </label>
            )}
            {turns.length > 0 && (
              <button type="button" className="btn btn--quiet" onClick={newConversation}>
                {T("newConversation")}
              </button>
            )}
          </div>
        </form>

        <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
          {announce}
        </div>
      </section>

      <aside className="side" aria-label={T("side")}>
        {undo && left > 0 && (
          <section className="panel undo" aria-labelledby="undo-title">
            <h2 id="undo-title">{T("undoTitle")}</h2>
            <p>
              {T("timeLeft")} <span className="undo__time">{mmss(left)}</span>
            </p>
            <p>{T("undoText")}</p>
            <button type="button" className="btn btn--danger" onClick={() => void cancelOrder(false)}>
              {T("cancelOrder")}
            </button>
          </section>
        )}
        <section className="panel" aria-labelledby="cart-title">
          <h2 id="cart-title">{T("cartTitle")}</h2>
          {cart ? <p>{T("cartLine", { count: `${cart.itemCount} ${cart.itemCount === 1 ? T("item") : T("items")}`, total: cart.total })}</p> : <p>{T("cartEmpty")}</p>}
        </section>
        <section className="panel" aria-labelledby="promise-title">
          <h2 id="promise-title">{T("promisesTitle")}</h2>
          <ul>
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
        onTalk={talk}
        onConfirm={() => void confirm(false)}
        onChange={() => closeReadback("change")}
        onCancel={() => closeReadback("dont")}
      />
    </div>
  );
}
