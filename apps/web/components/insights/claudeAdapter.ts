/**
 * AG Studio's "LLM adapter", pointed at Claude through our own server.
 *
 * AG Studio calls executeTurn() once per AI step. We send the turn to
 * /api/merchant/studio-ai (which runs it on Claude) and translate the answer
 * back into AG Studio's two shapes:
 *   - stream: events as they "arrive" (text, tool calls)
 *   - complete: the final response with its output items
 * Our server answers in one piece, so the stream simply replays it.
 *
 * The API key never reaches the browser: only our server talks to Anthropic.
 */
import type { AgAiEvent, AgLlmAdapter, AgLlmExecuteTurnOptions, AgLlmRequest, AgLlmResponse } from "ag-studio";

type Turn = { text: string; toolCalls: { callId: string; name: string; arguments: string }[]; usage: { inputTokens: number; outputTokens: number }; model: string };

const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

export function buildTurnResult(turn: Turn): { events: AgAiEvent[]; response: AgLlmResponse } {
  const events: AgAiEvent[] = [];
  const output: AgLlmResponse["output"] = [];
  if (turn.text) {
    const messageId = uid("msg");
    events.push({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" });
    events.push({ type: "TEXT_MESSAGE_CONTENT", messageId, delta: turn.text });
    events.push({ type: "TEXT_MESSAGE_END", messageId });
    output.push({ id: messageId, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: turn.text, annotations: [] }] });
  }
  for (const c of turn.toolCalls) {
    events.push({ type: "TOOL_CALL_START", toolCallId: c.callId, toolCallName: c.name });
    events.push({ type: "TOOL_CALL_ARGS", toolCallId: c.callId, delta: c.arguments });
    events.push({ type: "TOOL_CALL_END", toolCallId: c.callId });
    output.push({ id: uid("fc"), kind: "output", type: "function_call", callId: c.callId, name: c.name, arguments: c.arguments, status: "completed" });
  }
  const response: AgLlmResponse = {
    id: uid("resp"),
    createdAt: Date.now(),
    output,
    status: "completed",
    model: turn.model,
    usage: { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, totalTokens: turn.usage.inputTokens + turn.usage.outputTokens },
  };
  return { events, response };
}

function failed(message: string): { events: AgAiEvent[]; response: AgLlmResponse } {
  return { events: [], response: { id: uid("resp"), createdAt: Date.now(), output: [], status: "failed", error: { code: "open_aisle", message } } };
}

export function claudeAdapter(endpoint = "/api/merchant/studio-ai"): AgLlmAdapter {
  return {
    executeTurn(request: AgLlmRequest, options?: AgLlmExecuteTurnOptions) {
      const result = (async () => {
        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: request.input,
              instructions: request.instructions,
              tools: request.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
              toolChoice: request.toolChoice,
              responseFormat: request.responseFormat,
            }),
            signal: options?.signal,
          });
          const d = (await res.json()) as ({ ok: true } & Turn) | { ok: false; error: string };
          return d.ok ? buildTurnResult(d) : failed(d.error);
        } catch (err) {
          if (options?.signal?.aborted) return { events: [], response: { ...failed("Cancelled.").response, status: "cancelled" as const } };
          return failed(err instanceof Error ? err.message : "The assistant couldn't be reached.");
        }
      })();

      return {
        stream: {
          async *[Symbol.asyncIterator]() {
            const { events } = await result;
            for (const e of events) yield e;
          },
        },
        complete: result.then((r) => r.response),
      };
    },
  };
}
