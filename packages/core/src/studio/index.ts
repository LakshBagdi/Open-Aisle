/**
 * Claude behind AG Studio's AI Assistant.
 *
 * AG Studio (the merchant insights dashboard) has a built-in assistant that
 * can build and change the dashboard: "chart barriers by kind", "which store
 * loses most sales to missing size charts?". AG Studio never talks to an AI
 * provider itself. It asks the page for ONE turn at a time through an
 * "LLM adapter": here is the conversation, the instructions and the tools,
 * give me back text and/or tool calls.
 *
 * The browser adapter (apps/web/components/studioAdapter.ts) sends that turn
 * to our server, and this file runs it on Claude. We don't execute the tools:
 * they are AG Studio's own dashboard tools and run in the browser. We only
 * return which ones Claude wants to call, with what arguments.
 *
 * Analogy: AG Studio is a pilot with a checklist; Claude is the co-pilot who
 * says which switch to flip next; the switches stay in the pilot's cockpit.
 */
import { generateText, jsonSchema, Output, tool, type LanguageModel, type ModelMessage, type ToolSet } from "ai";

// ─── The parts of AG Studio's request we use (its OpenAI-Responses-style shape) ──

type TextPart = { type: "text"; text: string } | { type: "refusal"; refusal: string } | { type: string; [k: string]: unknown };

export type StudioItem =
  | { type: "message"; role: "user" | "system"; content: TextPart[]; kind?: "input" }
  | { type: "message"; role: "assistant"; content: TextPart[]; kind?: "output" }
  | { type: "function_call"; callId: string; name: string; arguments: string; kind?: "output" }
  | { type: "function_call_output"; callId: string; output: string; kind?: "input" }
  | { type: "reasoning"; [k: string]: unknown };

export type StudioRequest = {
  input: StudioItem[];
  instructions?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json"; name: string; description?: string; schema: Record<string, unknown> };
};

export type StudioTurn = {
  text: string;
  toolCalls: { callId: string; name: string; arguments: string }[];
  usage: { inputTokens: number; outputTokens: number };
  model: string;
};

/** Claude's tool names must match ^[a-zA-Z0-9_-]{1,64}$. AG's names are mapped if needed. */
function safeName(name: string, used: Set<string>): string {
  let s = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
  let n = 2;
  while (used.has(s)) s = `${s.slice(0, 60)}_${n++}`;
  used.add(s);
  return s;
}

function textOf(parts: TextPart[]): string {
  return parts
    .map((p) => (p.type === "text" ? String((p as { text: string }).text) : p.type === "refusal" ? String((p as { refusal: string }).refusal) : ""))
    .filter(Boolean)
    .join("\n");
}

function parseArgs(json: string): unknown {
  try {
    return json.trim() ? JSON.parse(json) : {};
  } catch {
    return { _raw: json };
  }
}

/** AG Studio's conversation → AI SDK messages. Exported for tests. */
export function toModelMessages(input: StudioItem[], toAiName: (agName: string) => string): { messages: ModelMessage[]; system: string[] } {
  const messages: ModelMessage[] = [];
  const system: string[] = [];
  const callNames = new Map<string, string>();

  const lastAssistant = () => {
    const last = messages.at(-1);
    if (last?.role === "assistant" && Array.isArray(last.content)) return last.content as Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string>;
    const parts: Exclude<Extract<ModelMessage, { role: "assistant" }>["content"], string> = [];
    messages.push({ role: "assistant", content: parts });
    return parts;
  };
  const lastTool = () => {
    const last = messages.at(-1);
    if (last?.role === "tool") return last.content;
    const parts: Extract<ModelMessage, { role: "tool" }>["content"] = [];
    messages.push({ role: "tool", content: parts });
    return parts;
  };

  for (const item of input) {
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      const text = textOf(item.content);
      if (!text) continue;
      if (item.role === "system") system.push(text);
      else if (item.role === "user") messages.push({ role: "user", content: text });
      else lastAssistant().push({ type: "text", text });
    } else if (item.type === "function_call") {
      const toolName = toAiName(item.name);
      callNames.set(item.callId, toolName);
      lastAssistant().push({ type: "tool-call", toolCallId: item.callId, toolName, input: parseArgs(item.arguments) });
    } else if (item.type === "function_call_output") {
      const toolName = callNames.get(item.callId);
      if (!toolName) continue; // a result for a call we never saw: drop it rather than confuse the model
      lastTool().push({ type: "tool-result", toolCallId: item.callId, toolName, output: { type: "text", value: item.output } });
    }
  }
  return { messages, system };
}

const GUIDE = `You are the analytics assistant inside Open Aisle's store dashboard (AG Studio).
Open Aisle is an AI shopping companion for blind and low-vision shoppers and others the web leaves out. Stores use this dashboard to see:
- orders: PayPal orders through Open Aisle. status "voided" = the shopper cancelled inside the undo window, so nothing was charged (a mistake caught); "captured" = paid; amount is in US dollars.
- barriers: information shoppers needed that the store didn't give (no photo description, no size chart, no return policy, material not listed). shopper_hits = how many times shoppers needed it.
- agent_turns: the shopping agent's replies. passed_first_time = 1 when every price and size in the reply was found in the store's data on the first try.
Use only the data sources. Never invent numbers. Prefer clear titles that say the finding ("Size charts are the most-hit barrier"). Keep text replies short and plain.`;

export async function runStudioTurn(req: StudioRequest, model: LanguageModel, maxOutputTokens = 4000): Promise<StudioTurn> {
  const used = new Set<string>();
  const agToAi = new Map<string, string>();
  const aiToAg = new Map<string, string>();
  for (const t of req.tools ?? []) {
    const n = safeName(t.name, used);
    agToAi.set(t.name, n);
    aiToAg.set(n, t.name);
  }
  const toAiName = (n: string) => agToAi.get(n) ?? safeName(n, used);

  const tools: ToolSet = {};
  for (const t of req.tools ?? []) {
    tools[toAiName(t.name)] = tool({
      description: t.description.slice(0, 4000),
      inputSchema: jsonSchema({ type: "object", properties: {}, ...t.parameters } as Parameters<typeof jsonSchema>[0]),
    });
  }

  const { messages, system } = toModelMessages(req.input, toAiName);
  if (messages.length === 0 || messages[0]?.role !== "user") messages.unshift({ role: "user", content: "(The dashboard is open.)" });

  const choice = req.toolChoice;
  const toolChoice =
    !choice || choice === "auto" ? "auto" : choice === "none" ? "none" : choice === "required" ? "required" : { type: "tool" as const, toolName: toAiName(choice.name) };
  const hasTools = Object.keys(tools).length > 0;
  const json = req.responseFormat?.type === "json" ? req.responseFormat : undefined;

  const result = await generateText({
    model,
    instructions: [GUIDE, req.instructions, ...system].filter(Boolean).join("\n\n"),
    messages,
    ...(hasTools ? { tools, toolChoice } : {}),
    ...(json && !hasTools ? { output: Output.object({ schema: jsonSchema(json.schema as Parameters<typeof jsonSchema>[0]), name: json.name, description: json.description }) } : {}),
    maxOutputTokens,
    temperature: 0.2,
  });

  return {
    text: json && !hasTools && result.output !== undefined ? JSON.stringify(result.output) : result.text,
    toolCalls: result.toolCalls.map((c) => ({ callId: c.toolCallId, name: aiToAg.get(c.toolName) ?? c.toolName, arguments: JSON.stringify(c.input ?? {}) })),
    usage: { inputTokens: result.totalUsage.inputTokens ?? 0, outputTokens: result.totalUsage.outputTokens ?? 0 },
    model: typeof model === "string" ? model : model.modelId,
  };
}
