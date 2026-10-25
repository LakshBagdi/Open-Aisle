"use client";
import { useEffect, useRef, useState } from "react";

type Settings = {
  user: { displayName: string; language: "en" | "hi"; modes: { screenReader: boolean; voice: boolean; plainWords: boolean; largeText: boolean; handsFree?: boolean; speechRate?: number } };
  paypalConnected: boolean;
  payerEmail: string | null;
  rules: { perOrderCents: number; monthlyCents: number; allowedStoreIds: string[]; undoWindowSeconds: number } | null;
  stores: { id: string; name: string }[];
};

const MODE_LABELS = {
  screenReader: { label: "I use a screen reader", hint: "Replies are announced by your screen reader." },
  voice: { label: "Always read replies aloud", hint: "When you talk, I always answer out loud. Turn this on to also hear replies when you type. Leave it off if your screen reader already speaks." },
  handsFree: { label: "Hands-free conversation", hint: "After each spoken reply I listen again, so you can shop without pressing anything." },
  plainWords: { label: "Plain words", hint: "Shorter replies and one choice at a time." },
  largeText: { label: "Larger text", hint: "Makes all text bigger." },
} as const;

export function SettingsForm() {
  const [s, setS] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const statusRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => (d.ok ? setS(d) : setError(d.error)))
      .catch(() => setError("Settings couldn't be loaded."));
  }, []);

  if (error && !s) return <p className="notice notice--error" role="alert">{error}</p>;
  if (!s) return <p role="status">Loading settings…</p>;

  async function save(form: HTMLFormElement) {
    setError(null);
    setSaved(null);
    const f = new FormData(form);
    const body = {
      displayName: String(f.get("displayName") ?? ""),
      language: f.get("language") as "en" | "hi",
      modes: { ...Object.fromEntries(Object.keys(MODE_LABELS).map((k) => [k, f.get(k) === "on"])), speechRate: Number(f.get("speechRate") ?? 1) },
      limits: {
        perOrderDollars: Number(f.get("perOrder")),
        monthlyDollars: Number(f.get("monthly")),
        undoMinutes: Number(f.get("undo")),
        allowedStoreIds: f.getAll("stores").map(String),
      },
    };
    const d = await (await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
    if (!d.ok) setError(d.error);
    else {
      setSaved("Settings saved. Your new limits are signed and active.");
      if ((body.modes as unknown as Record<string, boolean>).largeText !== s!.user.modes.largeText || body.language !== s!.user.language) location.reload();
    }
    statusRef.current?.focus();
  }

  function sample() {
    const rate = Number((document.getElementById("speechRate") as HTMLSelectElement | null)?.value ?? 1);
    if (!window.speechSynthesis) return setError("This browser can't speak. Try Chrome, Edge or Safari.");
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(s!.user.language === "hi" ? "नमस्ते। मैं इस गति से बोलूँगा।" : "Hello. This is how fast I'll speak your replies.");
    u.lang = s!.user.language === "hi" ? "hi-IN" : "en-US";
    u.rate = rate;
    window.speechSynthesis.speak(u);
  }

  async function connect() {
    setConnecting(true);
    setError(null);
    const d = await (await fetch("/api/paypal/connect", { method: "POST" })).json().catch(() => ({ ok: false, error: "PayPal couldn't be reached." }));
    if (d.ok) location.assign(d.approveUrl);
    else {
      setError(d.error);
      setConnecting(false);
    }
  }

  const r = s.rules;
  return (
    <>
      <p ref={statusRef} tabIndex={-1} role={error ? "alert" : "status"} className={error || saved ? `notice${error ? " notice--error" : ""}` : "visually-hidden"}>
        {error ?? saved ?? ""}
      </p>

      <section id="paypal" aria-labelledby="paypal-title" className="panel" style={{ maxWidth: "44rem" }}>
        <h2 id="paypal-title">PayPal</h2>
        {s.paypalConnected ? (
          <p>Connected{s.payerEmail ? ` as ${s.payerEmail}` : ""}. Open Aisle pays only after you confirm the exact order, and you can cancel during the undo window.</p>
        ) : (
          <>
            <p>Connect once. You'll go to PayPal's own page to approve; a helper can do this step with you. After that there are no pop-ups.</p>
            <button type="button" className="btn btn--primary" onClick={connect} disabled={connecting}>
              {connecting ? "Opening PayPal…" : "Connect PayPal"}
            </button>
          </>
        )}
      </section>

      <form
        style={{ maxWidth: "44rem", marginTop: "2rem" }}
        onSubmit={(e) => {
          e.preventDefault();
          void save(e.currentTarget);
        }}
      >
        <fieldset>
          <legend>About you</legend>
          <label htmlFor="displayName">What should I call you?</label>
          <input id="displayName" name="displayName" type="text" defaultValue={s.user.displayName} />
          <label htmlFor="language" style={{ marginTop: "1rem" }}>
            Language
          </label>
          <select id="language" name="language" defaultValue={s.user.language}>
            <option value="en">English</option>
            <option value="hi">हिन्दी (Hindi)</option>
          </select>
        </fieldset>

        <fieldset>
          <legend>How we talk</legend>
          {(Object.keys(MODE_LABELS) as (keyof typeof MODE_LABELS)[]).map((k) => (
            <div key={k} className="check">
              <input type="checkbox" id={`m-${k}`} name={k} defaultChecked={Boolean(s.user.modes[k])} aria-describedby={`m-${k}-hint`} />
              <div>
                <label htmlFor={`m-${k}`} style={{ margin: 0 }}>
                  {MODE_LABELS[k].label}
                </label>
                <p className="hint" id={`m-${k}-hint`} style={{ margin: 0 }}>
                  {MODE_LABELS[k].hint}
                </p>
              </div>
            </div>
          ))}
          <label htmlFor="speechRate" style={{ marginTop: "1rem" }}>
            Speaking speed
          </label>
          <div className="btn-row" style={{ alignItems: "center" }}>
            <select id="speechRate" name="speechRate" defaultValue={String(s.user.modes.speechRate ?? 1)} style={{ maxWidth: "16rem" }}>
              <option value="0.8">Slower</option>
              <option value="1">Normal</option>
              <option value="1.3">Faster</option>
              <option value="1.6">Much faster</option>
              <option value="2">Fastest</option>
            </select>
            <button type="button" className="btn" onClick={sample}>
              Hear a sample
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend>Spending limits</legend>
          <p className="hint">Open Aisle checks these before every payment. They are signed, so they can't be changed behind your back.</p>
          <label htmlFor="perOrder">Most I can spend on one order, in dollars</label>
          <input id="perOrder" name="perOrder" type="number" min={1} step={1} required defaultValue={r ? r.perOrderCents / 100 : 100} />
          <label htmlFor="monthly" style={{ marginTop: "1rem" }}>
            Most I can spend in a month, in dollars
          </label>
          <input id="monthly" name="monthly" type="number" min={1} step={1} required defaultValue={r ? r.monthlyCents / 100 : 300} />
          <label htmlFor="undo" style={{ marginTop: "1rem" }}>
            Minutes to change my mind after ordering
          </label>
          <input id="undo" name="undo" type="number" min={1} max={60} step={1} required defaultValue={r ? Math.round(r.undoWindowSeconds / 60) : 10} />
          <fieldset style={{ marginTop: "1.25rem" }}>
            <legend style={{ fontSize: "inherit" }}>Stores I allow</legend>
            <p className="hint">Leave all unticked to allow every store.</p>
            {s.stores.map((st) => (
              <div className="check" key={st.id}>
                <input type="checkbox" id={`st-${st.id}`} name="stores" value={st.id} defaultChecked={r?.allowedStoreIds.includes(st.id)} />
                <label htmlFor={`st-${st.id}`} style={{ margin: 0, fontWeight: 400 }}>
                  {st.name}
                </label>
              </div>
            ))}
          </fieldset>
        </fieldset>

        <button type="submit" className="btn btn--primary">
          Save settings
        </button>
      </form>
    </>
  );
}
