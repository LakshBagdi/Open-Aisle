/**
 * Claude behind AG Studio's assistant: AG's conversation format converts
 * correctly, tool names that Claude can't accept are mapped and mapped back,
 * and tools are returned as calls (never run on the server).
 */
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { runStudioTurn, toModelMessages, type StudioItem } from "../src/studio";

const usage = {
  inputTokens: { total: 120, noCache: 120, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 30, text: 30, reasoning: undefined },
};

describe("AG Studio conversation → Claude messages", () => {
  it("pairs tool calls with their results and keeps system text out of the chat", () => {
    const input: StudioItem[] = [
      { type: "message", role: "system", content: [{ type: "text", text: "Dashboard has 3 sources." }] },
      { type: "message", role: "user", content: [{ type: "text", text: "Chart barriers by kind" }] },
      { type: "message", role: "assistant", content: [{ type: "text", text: "Let me look." }] },
      { type: "function_call", callId: "c1", name: "view_schema", arguments: "{}" },
      { type: "function_call_output", callId: "c1", output: '{"sources":["barriers"]}' },
      { type: "function_call_output", callId: "unknown", output: "dropped" },
    ];
    const { messages, system } = toModelMessages(input, (n) => n);
    expect(system).toEqual(["Dashboard has 3 sources."]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = messages[1]!.content as { type: string }[];
    expect(assistant.map((p) => p.type)).toEqual(["text", "tool-call"]);
    expect((messages[2]!.content as unknown[]).length).toBe(1);
  });
});

describe("one turn", () => {
  it("returns Claude's tool call under AG Studio's original tool name", async () => {
    let seenTools: string[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async (opts) => {
        seenTools = (opts.tools ?? []).map((t) => t.name);
        return {
          content: [
            { type: "text", text: "Adding a bar chart." },
            { type: "tool-call", toolCallId: "t1", toolName: "widgets_add", input: JSON.stringify({ type: "bar-chart-grouped" }) },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      },
    });
    const turn = await runStudioTurn(
      {
        input: [{ type: "message", role: "user", content: [{ type: "text", text: "Chart barriers by kind" }] }],
        tools: [{ name: "widgets.add", description: "Add a widget", parameters: { type: "object", properties: { type: { type: "string" } } } }],
      },
      model,
    );
    expect(seenTools).toEqual(["widgets_add"]); // dots aren't allowed in Claude tool names
    expect(turn.text).toBe("Adding a bar chart.");
    expect(turn.toolCalls).toEqual([{ callId: "t1", name: "widgets.add", arguments: '{"type":"bar-chart-grouped"}' }]);
    expect(turn.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });
});
