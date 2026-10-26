/**
 * The insights dashboard, defined in code so every store sees a finished
 * report on first load. AG Studio keeps a whole dashboard as one JSON object
 * (pages → widgets → which fields they show), so this file IS the dashboard.
 * Merchants can switch to Edit to change it, or ask the AI assistant.
 *
 * Field ids are "<source>.<field>", e.g. "orders.paid".
 */
import type { AgDataSourcesDefinition, AgReportState } from "ag-studio";

export type Dataset = {
  orders: { order_id: string; day: string; store: string; status: string; amount: number; paid: number; caught_by_undo: number; items: number; cancelled_in_undo: number }[];
  barriers: { store: string; product: string; category: string; kind: string; status: string; shopper_hits: number }[];
  agent_turns: { day: string; model: string; prompt_version: string; passed_first_time: number; rewritten: number; seconds: number; tokens: number }[];
};

const usd = { format: "$#,##0.00" };

export function dataSources(d: Dataset): AgDataSourcesDefinition {
  return {
    sources: [
      {
        id: "orders",
        name: "Orders",
        description: "PayPal orders placed through Open Aisle. voided = cancelled inside the undo window, nothing charged.",
        data: d.orders.map((o) => ({ ...o, day: new Date(`${o.day}T12:00:00Z`) })),
        fields: [
          { id: "order_id", name: "Order", format: "textFormat" },
          { id: "day", name: "Day", format: "dateFormat" },
          { id: "store", name: "Store", format: "textFormat" },
          { id: "status", name: "Status", format: "textFormat" },
          { id: "amount", name: "Order total", format: "currencyFormat", formatOptions: usd },
          { id: "paid", name: "Paid through PayPal", format: "currencyFormat", formatOptions: usd },
          { id: "caught_by_undo", name: "Cancelled before charge", format: "currencyFormat", formatOptions: usd },
          { id: "items", name: "Items", format: "integerFormat" },
          { id: "cancelled_in_undo", name: "Mistakes caught by undo", format: "integerFormat" },
        ],
      },
      {
        id: "barriers",
        name: "Barriers",
        description: "Information shoppers needed that the store didn't give.",
        data: d.barriers,
        fields: [
          { id: "store", name: "Store", format: "textFormat" },
          { id: "product", name: "Product", format: "textFormat" },
          { id: "category", name: "Category", format: "textFormat" },
          { id: "kind", name: "What's missing", format: "textFormat" },
          { id: "status", name: "Status", format: "textFormat" },
          { id: "shopper_hits", name: "Shopper hits", format: "integerFormat" },
        ],
      },
      {
        id: "agent_turns",
        name: "Agent replies",
        description: "Each reply the shopping agent gave. passed_first_time = every price and size was found in store data on the first try.",
        data: d.agent_turns.map((t) => ({ ...t, day: new Date(`${t.day}T12:00:00Z`) })),
        fields: [
          { id: "day", name: "Day", format: "dateFormat" },
          { id: "model", name: "Model", format: "textFormat" },
          { id: "prompt_version", name: "Prompt version", format: "textFormat" },
          { id: "passed_first_time", name: "Grounded first time", format: "integerFormat" },
          { id: "rewritten", name: "Rewritten after fact check", format: "integerFormat" },
          { id: "seconds", name: "Seconds", format: "decimalFormat" },
          { id: "tokens", name: "Tokens", format: "integerFormat" },
        ],
      },
    ],
  } as unknown as AgDataSourcesDefinition;
}

const title = (text: string) => ({ title: { enabled: true, text } });

export const INITIAL_STATE = {
  selectedPageId: "overview",
  pages: [
    {
      id: "overview",
      widgets: {
        byKind: {
          type: "bar-chart-grouped",
          dataMapping: { categoryKey: [{ id: "barriers.kind" }], valueKey: [{ id: "barriers.shopper_hits", aggregation: "sum" }] },
          format: title("What shoppers needed but didn't get"),
        },
        byStatus: {
          type: "donut-chart",
          dataMapping: { categoryKey: [{ id: "orders.status" }], valueKey: [{ id: "orders.amount", aggregation: "sum" }] },
          format: title("Order value by outcome"),
        },
        table: {
          type: "grid",
          dataMapping: { cols: [{ id: "barriers.product" }, { id: "barriers.kind" }, { id: "barriers.status" }] },
          format: title("Barriers by product"),
        },
      },
      widgetLayout: {
        byKind: { xTrack: 0, yTrack: 0, xSpan: 14, ySpan: 18 },
        byStatus: { xTrack: 14, yTrack: 0, xSpan: 10, ySpan: 18 },
        table: { xTrack: 0, yTrack: 18, xSpan: 24, ySpan: 22 },
      },
    },
    {
      id: "agent",
      widgets: {
        replies: { type: "value", dataMapping: { value: [{ id: "agent_turns.tokens", aggregation: "count" }] }, format: title("Agent replies") },
        firstTime: { type: "value", dataMapping: { value: [{ id: "agent_turns.passed_first_time", aggregation: "sum" }] }, format: title("Fact-checked first time") },
        rewritten: { type: "value", dataMapping: { value: [{ id: "agent_turns.rewritten", aggregation: "sum" }] }, format: title("Rewritten after check") },
        perDay: {
          type: "column-chart-grouped",
          dataMapping: { categoryKey: [{ id: "agent_turns.day" }], valueKey: [{ id: "agent_turns.passed_first_time", aggregation: "sum" }, { id: "agent_turns.rewritten", aggregation: "sum" }] },
          format: title("Every price and size checked against store data"),
        },
      },
      widgetLayout: {
        replies: { xTrack: 0, yTrack: 0, xSpan: 8, ySpan: 5 },
        firstTime: { xTrack: 8, yTrack: 0, xSpan: 8, ySpan: 5 },
        rewritten: { xTrack: 16, yTrack: 0, xSpan: 8, ySpan: 5 },
        perDay: { xTrack: 0, yTrack: 5, xSpan: 24, ySpan: 16 },
      },
    },
  ],
} as unknown as AgReportState;

export const PROMPT_STARTERS = [
  { label: "Most-hit barriers", prompt: "Which products have the most barrier hits? Add a chart." },
  { label: "Undo window", prompt: "How much money was cancelled before it was charged, by store?" },
  { label: "Agent honesty", prompt: "Show how many agent replies passed the fact check first time, by day." },
];
