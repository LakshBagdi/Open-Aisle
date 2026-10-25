/**
 * One conversation turn:
 *   1. load history, 2. let Claude call tools until it has an answer,
 *   3. grounding check, retry once if needed, 4. save and return.
 *
 * Not streamed token by token on purpose: the grounding check needs the whole
 * reply before anything is spoken. Turns are short, so the wait is small, and
 * the app announces "Looking..." to screen readers meanwhile.
 */
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateText, isStepCount, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware, type ModelMessage } from "ai";
import { asc, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { aiRuns, conversations, messages, users } from "../db/schema";
import { env } from "../env";
import type { Lang } from "../i18n";
import { checkGrounding, removeUngroundedSentences, toSpeakable, type GroundingResult } from "./grounding";
import { PROMPT_VERSION, systemPrompt } from "./prompt";
import { createTools, type AgentEvent } from "./tools";
import { basicTurn } from "./basic";
import { describeAiError } from "./errors";

export class AgentUnavailableError extends Error {
  name = "AgentUnavailableError";
}

/** Used when AGENT_MODEL still names a Claude model but another provider is chosen. */
const PROVIDER_DEFAULT_MODEL = { google: "gemini-3.8-flash", groq: "llama-3.3-70b-versatile" } as const;

/**
 * Gemini 3 "thinks" before answering, and those thinking tokens count against
 * maxOutputTokens. With our small caps (replies are meant to be short) the
 * thinking can use the whole budget and the reply comes back empty. So: keep
 * thinking low and give every call extra room on top of its reply budget.
 */
const geminiHeadroom: LanguageModelMiddleware = {
  specificationVersion: "v4",
  transformParams: async ({ params }) => ({
    ...params,
    maxOutputTokens: params.maxOutputTokens === undefined ? undefined : params.maxOutputTokens + 2048,
    providerOptions: {
      ...params.providerOptions,
      google: { thinkingConfig: { thinkingLevel: "low" }, ...params.providerOptions?.google },
    },
  }),
};

export function defaultModel(): LanguageModel {
  const e = env();
  const baseURL = e.AI_BASE_URL || undefined;
  if (e.AI_PROVIDER === "google") {
    if (!e.GOOGLE_GENERATIVE_AI_API_KEY) throw new AgentUnavailableError("GOOGLE_GENERATIVE_AI_API_KEY is not set, so the shopping agent can't think yet.");
    const id = e.AGENT_MODEL.startsWith("claude") ? PROVIDER_DEFAULT_MODEL.google : e.AGENT_MODEL;
    return wrapLanguageModel({ model: createGoogleGenerativeAI({ apiKey: e.GOOGLE_GENERATIVE_AI_API_KEY, baseURL })(id), middleware: geminiHeadroom });
  }
  if (e.AI_PROVIDER === "groq") {
    if (!e.GROQ_API_KEY) throw new AgentUnavailableError("GROQ_API_KEY is not set, so the shopping agent can't think yet.");
    const id = e.AGENT_MODEL.startsWith("claude") ? PROVIDER_DEFAULT_MODEL.groq : e.AGENT_MODEL;
    return createGroq({ apiKey: e.GROQ_API_KEY, baseURL })(id);
  }
  if (!e.ANTHROPIC_API_KEY) throw new AgentUnavailableError("ANTHROPIC_API_KEY is not set, so the shopping agent can't think yet.");
  return createAnthropic({ apiKey: e.ANTHROPIC_API_KEY })(e.AGENT_MODEL);
}

export type TurnResult = {
  conversationId: string;
  reply: string;
  events: AgentEvent[];
  grounding: GroundingResult;
  /** "ai" = Claude answered; "basic" = simple mode (no key, or the AI service was unreachable). */
  mode: "ai" | "basic";
};

const HISTORY_TURNS = 12;

async function loadHistory(conversationId: string): Promise<ModelMessage[]> {
  const rows = await getDb()
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(HISTORY_TURNS * 2);
  const history: ModelMessage[] = [];
  for (const m of rows.reverse()) {
    if (m.role === "user") history.push({ role: "user", content: m.text });
    else if (m.role === "assistant") {
      // Simple-mode turns store a small memory object, not model messages; skip those.
      const stored = (m.toolCalls as unknown[]).filter((x): x is ModelMessage => typeof x === "object" && x !== null && "role" in x);
      if (stored.length > 0) history.push(...stored);
      else history.push({ role: "assistant", content: m.text });
    }
  }
  return history;
}

/** Every tool result the agent has seen, as text, for the grounding check. */
function factsFrom(msgs: ModelMessage[]): string {
  const parts: string[] = [];
  for (const m of msgs) {
    if (m.role !== "tool") continue;
    for (const c of m.content) if (c.type === "tool-result") parts.push(JSON.stringify(c.output));
  }
  return parts.join("\n");
}

export async function runTurn(opts: { userId: string; text: string; conversationId?: string; model?: LanguageModel; now?: Date }): Promise<TurnResult> {
  const db = getDb();
  const [user] = await db.select().from(users).where(eq(users.id, opts.userId)).limit(1);
  if (!user) throw new Error("User not found");
  const lang: Lang = user.language;
  let model: LanguageModel | undefined = opts.model;
  if (!model) {
    try {
      model = defaultModel();
    } catch (err) {
      if (!(err instanceof AgentUnavailableError)) throw err;
    }
  }

  let conversationId = opts.conversationId;
  if (!conversationId) {
    const [c] = await db.insert(conversations).values({ userId: user.id }).returning();
    conversationId = c!.id;
  } else {
    const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    // A conversation from an old session (or another person): start a fresh one instead of failing.
    if (!c || c.userId !== user.id) {
      const [fresh] = await db.insert(conversations).values({ userId: user.id }).returning();
      conversationId = fresh!.id;
    }
  }

  if (!model) return basicReply({ userId: user.id, lang, conversationId, text: opts.text });

  const history = await loadHistory(conversationId);
  const now = opts.now ?? new Date();
  const instructions = systemPrompt({
    name: user.displayName,
    lang,
    plainWords: user.modes.plainWords,
    today: now.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
  });

  const events: AgentEvent[] = [];
  const orderFacts = { seen: false };
  const tools = createTools({ userId: user.id, lang, model, events, orderFacts });
  const started = Date.now();

  const call = (msgs: ModelMessage[]) =>
    generateText({ model, instructions, messages: msgs, tools, stopWhen: isStepCount(8), maxOutputTokens: 800, temperature: 0.2 });

  const input: ModelMessage[] = [...history, { role: "user", content: opts.text }];
  let result: Awaited<ReturnType<typeof call>>;
  try {
    result = await call(input);
  } catch (err) {
    // The AI service is down or refused: keep shopping working in simple mode.
    if (events.length > 0) throw err; // a tool already acted; don't repeat it
    // describeAiError logs a one-line reason (bad key, retired model, rate limit) for the developer.
    if (!describeAiError(err)) console.error("AI turn failed, using simple mode:", err instanceof Error ? err.message : err);
    return basicReply({ userId: user.id, lang, conversationId, text: opts.text, note: true });
  }
  let newMessages: ModelMessage[] = [...result.responseMessages];
  let reply = toSpeakable(result.text);
  let grounding = checkGrounding(reply, factsFrom([...history, ...newMessages]), orderFacts.seen);

  if (!grounding.passed) {
    // One retry, telling the model exactly what it got wrong.
    const fix: ModelMessage = {
      role: "user",
      content: `[Fact check from Open Aisle, not from the person] Your last reply stated things not found in any tool result: ${grounding.problems.join("; ")}. Rewrite the reply using only facts from tool results, or say you don't know. Don't mention this check.`,
    };
    const retry = await call([...input, ...newMessages, fix]);
    const retryReply = toSpeakable(retry.text);
    const retryGrounding = checkGrounding(retryReply, factsFrom([...history, ...newMessages, ...retry.responseMessages]), orderFacts.seen);
    newMessages = [...newMessages, ...retry.responseMessages.filter((m) => m.role === "tool"), { role: "assistant", content: retryReply }];
    reply = retryGrounding.passed ? retryReply : removeUngroundedSentences(retryReply, retryGrounding.problems, lang);
    grounding = { passed: retryGrounding.passed, problems: [...grounding.problems.map((p) => `first draft: ${p}`), ...retryGrounding.problems] };
    result = retry;
  }

  if (!reply) reply = lang === "hi" ? "मैंने यह कर दिया।" : "Done.";

  // Store the turn. Assistant messages keep their tool calls so the next turn remembers ids.
  const finalAssistant: ModelMessage = { role: "assistant", content: reply };
  const stored = [...newMessages.filter((m) => !(m.role === "assistant" && typeof m.content === "string")), finalAssistant];
  await db.insert(messages).values([
    { conversationId, role: "user", text: opts.text },
    { conversationId, role: "assistant", text: reply, toolCalls: stored, groundingCheck: grounding },
  ]);
  await db.insert(aiRuns).values({
    conversationId,
    step: "turn",
    model: typeof model === "string" ? model : `${model.provider}:${model.modelId}`,
    promptVersion: PROMPT_VERSION,
    output: { reply, events: events.map((e) => e.type), grounding, steps: result.steps.length },
    inputTokens: result.totalUsage.inputTokens ?? null,
    outputTokens: result.totalUsage.outputTokens ?? null,
    durationMs: Date.now() - started,
  });

  return { conversationId, reply, events, grounding, mode: "ai" };
}

/** A turn in simple mode (see basic.ts), stored like any other turn. */
async function basicReply(o: { userId: string; lang: Lang; conversationId: string; text: string; note?: boolean }): Promise<TurnResult> {
  const events: AgentEvent[] = [];
  const turn = await basicTurn({ ...o, events });
  const reply = o.note ? `${o.lang === "hi" ? "AI अभी उपलब्ध नहीं है, इसलिए मैं सरल मोड में हूँ।" : "The AI isn't reachable right now, so I'm in simple mode."} ${turn.reply}` : turn.reply;
  const grounding = { passed: true, problems: [] };
  await getDb()
    .insert(messages)
    .values([
      { conversationId: o.conversationId, role: "user", text: o.text },
      { conversationId: o.conversationId, role: "assistant", text: reply, toolCalls: [turn.memory], groundingCheck: grounding },
    ]);
  return { conversationId: o.conversationId, reply, events, grounding, mode: "basic" };
}

export async function conversationMessages(userId: string, conversationId: string) {
  const db = getDb();
  const [c] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
  if (!c || c.userId !== userId) return [];
  return db
    .select({ id: messages.id, role: messages.role, text: messages.text, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.createdAt));
}
