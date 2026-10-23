"use client";
/**
 * The fix board: every barrier as a card on a Bryntum TaskBoard, in four
 * columns (Needs a fix → Being fixed → Fixed, plus Not needed).
 *
 * Rules the board enforces:
 *  - Dragging between Needs a fix / Being fixed / Not needed just moves it.
 *  - Dropping on "Fixed" never marks it fixed by itself. It opens the fix form,
 *    because a barrier is only fixed when real information reaches shoppers.
 *  - Every move can also be done without a mouse: select a card (Tab, arrow
 *    keys, Enter) and use the buttons in the fix form.
 *
 * Uses Bryntum's high-contrast theme, which matches Open Aisle's own focus on
 * low vision.
 */
import { BryntumTaskBoard } from "@bryntum/taskboard-react";
import "@bryntum/taskboard/fontawesome/css/fontawesome.css";
import "@bryntum/taskboard/fontawesome/css/solid.css";
import "@bryntum/taskboard/taskboard.css";
import "@bryntum/taskboard/high-contrast-light.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { barrierApi, KIND_LABEL, STATUS_LABEL, type Barrier, type BarrierStatus } from "./barriers";
import { FixPanel } from "./FixPanel";

const COLOR: Record<string, string> = {
  missing_alt_text: "blue",
  missing_size_chart: "orange",
  missing_return_policy: "red",
  missing_material: "purple",
  unclear_color: "teal",
};

const COLUMNS = (["open", "in_progress", "fixed", "dismissed"] as BarrierStatus[]).map((id) => ({ id, text: STATUS_LABEL[id]}));

type Card = { id: string; name: string; description: string; status: BarrierStatus; eventColor: string; weight: number };

export default function FixBoard() {
  const [stores, setStores] = useState<{ id: string; name: string }[]>([]);
  const [storeId, setStoreId] = useState("");
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

  const tasks = useMemo<Card[]>(
    () =>
      [...rows]
        .sort((a, b) => b.timesHit - a.timesHit)
        .map((b, i) => ({
          id: b.id,
          name: b.productTitle,
          description: `${KIND_LABEL[b.kind] ?? b.kind}. ${b.timesHit} ${b.timesHit === 1 ? "shopper" : "shoppers"} hit this.`,
          status: b.status,
          eventColor: COLOR[b.kind] ?? "gray",
          weight: i,
        })),
    [rows],
  );

  const byId = useCallback((id: unknown) => rows.find((r) => r.id === String(id)), [rows]);

  function say(text: string, error = false) {
    setMessage({ text, error });
    setTimeout(() => messageRef.current?.focus(), 0);
  }

  async function done(text: string) {
    setSelected(null);
    await load(storeId);
    say(text);
  }

  return (
    <>
      <div style={{ maxWidth: "24rem", marginBottom: "1.5rem" }}>
        <label htmlFor="board-store">Store</label>
        <select id="board-store" value={storeId} onChange={(e) => void load(e.target.value)}>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>

      <p ref={messageRef} tabIndex={-1} role={message?.error ? "alert" : "status"} className={message ? `notice${message.error ? " notice--error" : ""}` : "visually-hidden"}>
        {message?.text ?? ""}
      </p>

      <p className="hint" id="board-help">
        Drag a card to another column, or select it (Tab, then the arrow keys, then Enter) to open its fix form. Cards only reach Fixed when you write the missing
        information.
      </p>
      <div className="tool-frame" role="region" aria-label="Fix board" aria-describedby="board-help">
        <BryntumTaskBoard
          columnField="status"
          columns={COLUMNS}
          tasks={tasks}
          taskEditFeature={false}
          taskMenuFeature={false}
          columnHeaderMenuFeature={false}
          showCollapseInHeader={false}
          showCountInHeader
          stretchCards={false}
          useDomTransition
          onTaskClick={({ taskRecord }) => setSelected(byId(taskRecord.id) ?? null)}
          onActivateTask={({ taskRecord }) => setSelected(byId(taskRecord.id) ?? null)}
          onBeforeTaskDrop={({ taskRecords, targetColumn }) => {
            if (targetColumn.id === "fixed") {
              const b = byId(taskRecords[0]?.id);
              if (b && b.status !== "fixed") {
                setSelected(b);
                say("To move a card to Fixed, write what shoppers should hear and press Accept fix.");
              }
              return false;
            }
            return !taskRecords.some((t) => byId(t.id)?.status === "fixed");
          }}
          onTaskDrop={({ taskRecords, targetColumn }) => {
            const status = targetColumn.id as Exclude<BarrierStatus, "fixed">;
            void (async () => {
              for (const t of taskRecords) {
                const r = await barrierApi.setStatus(storeId, String(t.id), status);
                if (!r.ok) {
                  say(r.error, true);
                  return load(storeId);
                }
              }
              await load(storeId);
              say(`${taskRecords.length === 1 ? "Card" : "Cards"} moved to ${STATUS_LABEL[status]}.`);
            })();
          }}
        />
      </div>

      {selected && <FixPanel barrier={selected} storeId={storeId} onDone={(t) => void done(t)} onClose={() => setSelected(null)} />}
    </>
  );
}
