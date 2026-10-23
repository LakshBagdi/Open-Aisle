"use client";
/**
 * Store insights, built on AG Studio (AG Grid's embedded analytics).
 *
 * - The data: three flat tables from /api/merchant/analytics.
 * - The report: a finished dashboard defined in ./dashboard.ts.
 * - View / Edit: merchants can rearrange widgets or build new ones.
 * - The AI assistant: AG Studio's own agents, thinking with Claude through
 *   ./claudeAdapter.ts. "Which products have the most barrier hits?" becomes
 *   a chart on the page.
 *
 * Accessibility: the dashboard is a visual tool, so the same headline numbers
 * are also given above it as plain text, and the barrier report page has every
 * row in an accessible grid.
 */
import { AgStudio } from "ag-studio-react";
import { AgStudioAiModule, createAiHarness, type AgStudioMode } from "ag-studio";
import { useEffect, useMemo, useState } from "react";
import { claudeAdapter } from "./claudeAdapter";
import { dataSources, INITIAL_STATE, PROMPT_STARTERS, type Dataset } from "./dashboard";

type Load = { stores: { id: string; name: string }[]; data: Dataset; ai: boolean };

const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default function InsightsStudio() {
  const [store, setStore] = useState("all");
  const [loaded, setLoaded] = useState<Load | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<AgStudioMode>("view");

  useEffect(() => {
    let live = true;
    setLoaded(null);
    fetch(`/api/merchant/analytics?store=${store}`)
      .then((r) => r.json())
      .then((d) => {
        if (!live) return;
        if (!d.ok) setError(d.error);
        else setLoaded(d as Load);
      })
      .catch(() => live && setError("Couldn't load the numbers. Try again."));
    return () => {
      live = false;
    };
  }, [store]);

  const data = useMemo(() => (loaded ? dataSources(loaded.data) : undefined), [loaded]);
  const ai = loaded?.ai;
  const modules = useMemo(() => (ai ? [AgStudioAiModule] : []), [ai]);
  const harness = useMemo(
    () => (ai ? (params: { api: Parameters<typeof createAiHarness>[0] }) => createAiHarness(params.api, { adapter: claudeAdapter(), promptStarters: PROMPT_STARTERS }) : undefined),
    [ai],
  );

  const summary = useMemo(() => {
    if (!loaded) return null;
    const o = loaded.data.orders;
    return {
      paid: o.reduce((s, r) => s + r.paid, 0),
      caught: o.reduce((s, r) => s + r.cancelled_in_undo, 0),
      caughtMoney: o.reduce((s, r) => s + r.caught_by_undo, 0),
      hits: loaded.data.barriers.reduce((s, r) => s + r.shopper_hits, 0),
      open: loaded.data.barriers.filter((b) => b.status === "open" || b.status === "in progress").length,
    };
  }, [loaded]);

  return (
    <>
      <div className="btn-row" style={{ alignItems: "flex-end", marginBottom: "1.25rem" }}>
        <div style={{ minWidth: "18rem" }}>
          <label htmlFor="insights-store">Store</label>
          <select id="insights-store" value={store} onChange={(e) => setStore(e.target.value)}>
            <option value="all">All stores</option>
            {loaded?.stores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <button type="button" className="btn" aria-pressed={mode === "edit"} onClick={() => setMode(mode === "edit" ? "view" : "edit")}>
          {mode === "edit" ? "Done editing" : "Edit dashboard"}
        </button>
      </div>

      {error && (
        <p role="alert" className="notice notice--error">
          {error}
        </p>
      )}

      {summary && (
        <ul className="summary-row" aria-label="Headline numbers">
          <li>
            Paid through PayPal <strong>{money(summary.paid)}</strong>
          </li>
          <li>
            Mistakes caught by undo{" "}
            <strong>
              {summary.caught} ({money(summary.caughtMoney)})
            </strong>
          </li>
          <li>
            Barrier hits <strong>{summary.hits}</strong>
          </li>
          <li>
            Barriers still open <strong>{summary.open}</strong>
          </li>
        </ul>
      )}

      {!ai && loaded && <p className="hint">The AI assistant turns on when ANTHROPIC_API_KEY is set. The dashboard and editing work without it.</p>}

      <div className="tool-frame" role="region" aria-label="Insights dashboard">
        {data ? (
          <AgStudio
            key={`${store}-${ai ? "ai" : "plain"}`}
            data={data}
            initialState={INITIAL_STATE}
            mode={mode}
            modules={modules}
            ai={harness as never}
            style={{ height: "100%", width: "100%" }}
          />
        ) : (
          !error && <p role="status" style={{ padding: "1rem" }}>Loading the dashboard…</p>
        )}
      </div>
    </>
  );
}
