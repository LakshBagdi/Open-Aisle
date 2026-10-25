/**
 * Simple mode: Open Aisle without the AI.
 *
 * Used when there is no Anthropic key, or when the AI service is down. The
 * person can still shop with short, plain requests:
 *
 *   "running shoes under 60"     search
 *   "tell me about number 2"     product facts
 *   "describe the photo"         the store's photo description
 *   "add number 1, size 9"       add to cart
 *   "what's in my cart"          cart
 *   "buy it"                     read-back (then Confirm, exactly as with the AI)
 *   "cancel that"                cancel inside the undo window
 *   "where's my order"           order status
 *   "how much have I spent"      spending
 *
 * It runs the SAME tools as the AI agent, so every fact still comes from the
 * store's data and paying still needs the person's Confirm. Replies are built
 * from tool results, so they are grounded by construction.
 *
 * Analogy: when the clever assistant is off sick, the shop still has a clear
 * menu and the same till.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { messages } from "../db/schema";
import type { Lang } from "../i18n";
import { createTools, type AgentEvent } from "./tools";

type Hit = { product_id: string; title: string; price: string; store: string; arrives: string; options: Record<string, string[]>; key_facts: string[] };
export type BasicMemory = { basic: { results: { id: string; title: string; options: Record<string, string[]> }[]; focus?: string } };

const ORDINALS: Record<string, number> = { first: 1, one: 1, "1": 1, second: 2, two: 2, "2": 2, third: 3, three: 3, "3": 3, last: -1 };

/** "number 2", "the second one", "#2" → 2 (1-based). */
export function pickNumber(text: string): number | undefined {
  const m = text.match(/\b(?:number|no\.?|#|option|item)\s*(\d)\b|\b(first|second|third|last)\b|\bthe (one|two|three)\b|^\s*(\d)\s*$/i);
  const word = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4])?.toLowerCase();
  return word ? ORDINALS[word] : undefined;
}

/** Pull "size 9", "under $60", a colour, from a request. */
export function parseRequest(text: string) {
  const t = text.toLowerCase();
  const size = t.match(/\bsize\s+([a-z0-9.]+)/i)?.[1];
  const price = t.match(/(?:under|below|less than|max|up to|within|budget)\s*(?:\$|rs\.?|₹)?\s*(\d+(?:\.\d+)?)/)?.[1];
  const colors = ["black", "white", "grey", "gray", "blue", "red", "green", "navy", "brown", "pink", "yellow", "beige"];
  const color = colors.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  const query = t
    .replace(/\bsize\s+[a-z0-9.]+/g, " ")
    .replace(/(?:under|below|less than|max|up to|within|budget)\s*(?:\$|rs\.?|₹)?\s*\d+(?:\.\d+)?\s*(?:dollars?|usd|bucks)?/g, " ")
    .replace(/\b(i need|i want|looking for|find me|find|show me|search for|search|can you|please|some|a pair of|pair of|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { query: query || t, size, maxPrice: price ? Number(price) : undefined, color };
}

async function lastMemory(conversationId: string): Promise<BasicMemory["basic"] | undefined> {
  const rows = await getDb()
    .select({ toolCalls: messages.toolCalls })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.role, "assistant")))
    .orderBy(desc(messages.createdAt))
    .limit(6);
  for (const r of rows) {
    const mem = (r.toolCalls as unknown[]).find((x): x is BasicMemory => typeof x === "object" && x !== null && "basic" in x);
    if (mem) return mem.basic;
  }
  return undefined;
}

const HELP_EN =
  "I'm in simple mode right now, so please use short requests. For example: running shoes under 60. Tell me about number 2. Add number 1, size 9. What's in my cart. Buy it. Cancel that. Where's my order.";
const HELP_HI =
  "मैं अभी सरल मोड में हूँ, इसलिए छोटे वाक्य बोलिए। जैसे: running shoes under 60. Number 2 के बारे में बताओ। Add number 1, size 9. Buy it. रद्द करो।";

type Ctx = { userId: string; lang: Lang; conversationId: string; text: string; events: AgentEvent[] };

/** One turn in simple mode. Returns the reply and what to remember. */
export async function basicTurn(ctx: Ctx): Promise<{ reply: string; memory: BasicMemory; orderFacts: boolean }> {
  const orderFacts = { seen: false };
  const tools = createTools({ userId: ctx.userId, lang: ctx.lang, model: undefined as never, events: ctx.events, orderFacts });
  const run = <K extends keyof typeof tools>(name: K, input: unknown) =>
    (tools[name] as unknown as { execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<any> }).execute(input, { toolCallId: `basic-${String(name)}`, messages: [] });

  const mem = (await lastMemory(ctx.conversationId)) ?? { results: [] };
  const remember = (patch: Partial<BasicMemory["basic"]> = {}): BasicMemory => ({ basic: { ...mem, ...patch } });
  const t = ctx.text.trim().toLowerCase();
  const n = pickNumber(t);
  const chosen = n ? (n === -1 ? mem.results.at(-1) : mem.results[n - 1]) : mem.results.find((r) => r.id === mem.focus) ?? (mem.results.length === 1 ? mem.results[0] : undefined);
  const done = (reply: string, patch?: Partial<BasicMemory["basic"]>) => ({ reply, memory: remember(patch), orderFacts: orderFacts.seen });

  // Help
  if (/^(help|what can (i|you) (say|do)|मदद)\b/.test(t)) return done(ctx.lang === "hi" ? HELP_HI : HELP_EN);

  // Cancel (the undo window)
  if (/\b(cancel|undo)\b|रद्द|कैंसल/.test(t) && !/\bdon'?t\b/.test(t)) {
    const r = await run("cancel_order", {});
    return done("error" in r ? r.error : r.message);
  }

  // Orders
  if (/\b(my orders?|order status|where('?s| is) my|track|delivery of my)\b/.test(t)) {
    const r = await run("order_status", { limit: 3 });
    if (r.orders.length === 0) return done("You don't have any orders yet.");
    const lines = r.orders.map((o: any) => `${o.items.join(" and ")} from ${o.store}, ${o.amount}: ${o.status}${o.cancel_until ? `, you can cancel until ${o.cancel_until}` : ""}${o.tracking ? `. ${o.tracking}` : ""}.`);
    return done(`Your latest orders. ${lines.join(" ")}`);
  }

  // Spending
  if (/\b(spent|spending|budget|limit|how much (have|did) i)\b/.test(t)) {
    const r = await run("spending_summary", {});
    return done(`This month you've spent ${r.this_month}. You have ${r.left_this_month} left of your ${r.monthly_limit} monthly limit, and the most for one order is ${r.per_order_limit}.`);
  }

  // Cart
  if (/\b(my cart|in (my|the) (cart|basket)|view cart|show (my )?cart|cart)\b/.test(t) && !/\badd\b/.test(t)) {
    const r = await run("view_cart", {});
    if (!r.carts?.length) return done("Your cart is empty.");
    const c = r.carts[0];
    return done(`In your cart from ${c.store}: ${c.items.map((i: any) => `${i.title}${Object.keys(i.options).length ? `, ${Object.entries(i.options).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}, ${i.line_price}`).join("; ")}. Total ${c.total}. Say "buy it" when you're ready.`);
  }

  // Buy → read-back (the person still has to confirm)
  if (/\b(buy|checkout|check out|purchase|order it|place (the )?order|pay)\b|खरीद/.test(t)) {
    if (chosen && /\b(number|first|second|third|this one|it)\b/.test(t)) {
      // "buy number 2, size 9": add first, then read back.
      const { size, color } = parseRequest(t);
      const opts = optionsFor(chosen.options, size, color);
      const missing = Object.keys(chosen.options).find((k) => !opts[k]);
      const cart = await run("view_cart", {});
      const already = cart.carts?.some((c: any) => c.items.some((i: any) => i.product_id === chosen.id));
      if (!already) {
        if (missing) return done(`Which ${missing} would you like for the ${chosen.title}? Options: ${chosen.options[missing]!.join(", ")}.`, { focus: chosen.id });
        const added = await run("add_to_cart", { product_id: chosen.id, options: opts, quantity: 1 });
        if ("error" in added) return done(added.error, { focus: chosen.id });
      }
    }
    const r = await run("request_readback", {});
    if ("error" in r) return done(r.error === "The cart is empty." ? `Your cart is empty. Add something first, for example "add number 1, size 9".` : r.error);
    if (r.status === "blocked") return done(r.reason);
    return done("Here is your order. Please check it, then press Confirm, or say confirm.");
  }

  // Add to cart
  if (/\b(add|i'?ll take|i want (number|the)|get me (number|the))\b/.test(t) && mem.results.length > 0) {
    if (!chosen) return done(`Which one? Say "add number 1", "number 2" or "number 3".`);
    const { size, color } = parseRequest(t);
    const opts = optionsFor(chosen.options, size, color);
    const missing = Object.keys(chosen.options).find((k) => !opts[k]);
    if (missing) return done(`Which ${missing} would you like for the ${chosen.title}? Options: ${chosen.options[missing]!.join(", ")}.`, { focus: chosen.id });
    const qty = Number(t.match(/\b(\d+)\s*(?:of them|pairs|pieces|x)\b/)?.[1] ?? 1);
    const r = await run("add_to_cart", { product_id: chosen.id, options: opts, quantity: Math.min(Math.max(qty, 1), 10) });
    if ("error" in r) return done(r.error, { focus: chosen.id });
    return done(`Added the ${chosen.title}${Object.keys(opts).length ? `, ${Object.entries(opts).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}. Your cart is ${r.cart.total} with tax and delivery. Say "buy it" when you're ready, or keep shopping.`, { focus: chosen.id });
  }

  // Answering "Which size?" with just a size: "size 9" or "9"
  if (mem.focus && /^(size\s+)?[a-z0-9.]+$/.test(t)) {
    const focus = mem.results.find((r) => r.id === mem.focus);
    if (focus) {
      const value = t.replace(/^size\s+/, "");
      const opts = optionsFor(focus.options, value, value);
      const missing = Object.keys(focus.options).find((k) => !opts[k]);
      if (!missing) {
        const r = await run("add_to_cart", { product_id: focus.id, options: opts, quantity: 1 });
        if ("error" in r) return done(r.error);
        return done(`Added the ${focus.title}, ${Object.entries(opts).map(([k, v]) => `${k} ${v}`).join(", ")}. Your cart is ${r.cart.total}. Say "buy it" when you're ready.`);
      }
    }
  }

  // Photo
  if (/\b(photo|picture|image|look like|looks like|describe)\b/.test(t) && chosen) {
    const r = await run("describe_photo", { product_id: chosen.id }).catch(() => ({ source: "none", description: "I can't describe photos in simple mode." }));
    return done(r.say_first ? `${r.say_first}: ${r.description}` : r.description, { focus: chosen.id });
  }

  // Details
  if (chosen && (/\b(tell me|more about|details|about)\b/.test(t) || (n && t.split(/\s+/).length <= 3))) {
    const r = await run("get_product", { product_id: chosen.id });
    if ("error" in r) return done(r.error);
    const facts = Object.entries(r.facts as Record<string, string>).map(([k, v]) => `${k}: ${v}`).join(". ");
    const opts = Object.entries(r.options_to_choose as Record<string, string[]>).map(([k, v]) => `${k}s: ${v.join(", ")}`).join(". ");
    return done(
      `${r.title} from ${r.store}, ${r.price}. ${facts ? `${facts}. ` : ""}${opts ? `${opts}. ` : ""}Returns: ${r.return_policy} Arrives ${r.arrives}.${r.missing_information.length ? ` The store didn't provide: ${r.missing_information.join("; ").toLowerCase()}.` : ""}`,
      { focus: chosen.id },
    );
  }

  // Otherwise: search
  const { query, size, maxPrice, color } = parseRequest(ctx.text);
  const r = await run("search_products", { query, size, color, max_price_dollars: maxPrice });
  const hits = (r.results ?? []) as Hit[];
  if (hits.length === 0) return done(`I couldn't find anything for "${query}"${maxPrice ? ` under $${maxPrice}` : ""}. Try other words, or a higher price.`, { results: [], focus: undefined });
  const list = hits.map((h, i) => `Number ${i + 1}: ${h.title} from ${h.store}, ${h.price}, arrives ${h.arrives}.`).join(" ");
  return done(`I found ${hits.length}. ${list} Say "tell me about number 1", or "add number 1${size ? "" : ", size 9"}".`, {
    results: hits.map((h) => ({ id: h.product_id, title: h.title, options: h.options })),
    focus: undefined,
  });
}

/** Match the person's words to the product's real option values. */
function optionsFor(options: Record<string, string[]>, size?: string, color?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, values] of Object.entries(options)) {
    if (values.length === 1) out[name] = values[0]!;
    const want = name.toLowerCase() === "size" ? size : name.toLowerCase() === "color" ? color : undefined;
    if (!want) continue;
    const hit = values.find((v) => v.toLowerCase() === want.toLowerCase()) ?? values.find((v) => v.toLowerCase().startsWith(`${want.toLowerCase()} `) || v.toLowerCase().startsWith(`${want.toLowerCase()}(`));
    if (hit) out[name] = hit;
  }
  return out;
}
