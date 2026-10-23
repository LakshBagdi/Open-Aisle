"use client";
/**
 * Merchant barrier report.
 *
 * The grid gives the overview, most-hit first; choosing a row (click, or arrow
 * to it and press Enter or Space) opens the shared fix form below it.
 */
import { AgGridReact } from "ag-grid-react";
import type { ColDef, RowClassParams } from "ag-grid-community";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { accessibleGridOptions } from "./grid";
import { barrierApi, KIND_LABEL, STATUS_LABEL, type Barrier } from "./barriers";
import { FixPanel } from "./FixPanel";

export function BarrierReport() {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState<string>("");
  const [rows, setRows] = useState<Barrier[]>([]);
  const [selected, setSelected] = useState<Barrier | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);

  const load = useCallback(async (id?: string) => {
    const d = await barrierApi.load(id);
    if (!d.ok) return setMessage({ text: d.error, error: true });
    setStores(d.stores);
    setStoreId(d.storeId);
    setRows(d.barriers);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = useCallback((b: Barrier | undefined) => {
    if (!b) return;
    setSelected(b);
    setMessage(null);
  }, []);

  const columns = useMemo<ColDef<Barrier>[]>(
    () => [
      { field: "productTitle", headerName: "Product", flex: 2, minWidth: 220 },
      { field: "kind", headerName: "What's missing", flex: 2, minWidth: 220, valueFormatter: (p) => KIND_LABEL[p.value as string] ?? String(p.value) },
      { field: "timesHit", headerName: "Shoppers hit", width: 170, sort: "desc" },
      { field: "status", headerName: "Status", width: 170, valueFormatter: (p) => STATUS_LABEL[p.value as Barrier["status"]] ?? String(p.value) },
    ],
    [],
  );

  const open = rows.filter((r) => r.status === "open" || r.status === "in_progress");
  const fixed = rows.filter((r) => r.status === "fixed").length;
  const hits = open.reduce((s, r) => s + r.timesHit, 0);

  async function done(text: string) {
    setSelected(null);
    setMessage({ text });
    await load(storeId);
    setTimeout(() => messageRef.current?.focus(), 0);
  }

  return (
    <>
      <div style={{ maxWidth: "24rem", marginBottom: "1.5rem" }}>
        <label htmlFor="store">Store</label>
        <select id="store" value={storeId} onChange={(e) => void load(e.target.value)}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <ul className="summary-row" aria-label="Summary">
        <li>
          Open barriers <strong>{open.length}</strong>
        </li>
        <li>
          Times shoppers hit them <strong>{hits}</strong>
        </li>
        <li>
          Fixed <strong>{fixed}</strong>
        </li>
      </ul>

      <p ref={messageRef} tabIndex={-1} role={message?.error ? "alert" : "status"} className={message ? `notice${message.error ? " notice--error" : ""}` : "visually-hidden"}>
        {message?.text ?? ""}
      </p>

      <p className="hint" id="grid-help">
        Use the arrow keys to move. Press Enter on a row to fix that barrier.
      </p>
      <div className="grid-wrap" role="region" aria-label="Barriers" aria-describedby="grid-help">
        <AgGridReact<Barrier>
          {...accessibleGridOptions}
          rowData={rows}
          columnDefs={columns}
          defaultColDef={{ sortable: true, resizable: true }}
          getRowId={(p) => p.data.id}
          domLayout="autoHeight"
          rowSelection={{ mode: "singleRow", checkboxes: false, enableClickSelection: true }}
          onRowClicked={(e) => choose(e.data)}
          onCellKeyDown={(e) => {
            const key = (e.event as KeyboardEvent | undefined)?.key;
            if (key === "Enter" || key === " ") choose(e.data as Barrier);
          }}
          getRowStyle={(p: RowClassParams<Barrier>) => (p.data?.status === "fixed" || p.data?.status === "dismissed" ? { color: "#3d5470" } : undefined)}
        />
      </div>

      {selected && <FixPanel barrier={selected} storeId={storeId} onDone={(t) => void done(t)} onClose={() => setSelected(null)} />}
    </>
  );
}
