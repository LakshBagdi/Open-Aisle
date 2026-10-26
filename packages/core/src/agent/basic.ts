/**
 * Simple mode: Open Aisle without the AI.
 *
 * Used when there is no Anthropic key, or when the AI service is down. The
 * person can still shop with short, everyday requests:
 *
 *   "running shoes under 60"           search (remembers size and colour you said)
 *   "something under 50 dollars"       search by price only
 *   "tell me about number 2"           product facts
 *   "what is it made of", "is there a size chart", "how do returns work",
 *   "when will it arrive", "how much is it", "describe the photo"
 *   "add it", "add number 1, size 9"   add to cart (asks for a missing size)
 *   "remove it", "what's in my cart"
 *   "buy it"                           read-back (then Confirm, exactly as with the AI)
 *   "cancel that"                      cancel inside the undo window
 *   "where's my order", "how much have I spent", "help", "hi", "thanks"
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
type Result = { id: string; title: string; options: Record<string, string[]>; price?: string };
export type BasicMemory = { basic: { results: Result[]; focus?: string; wanted?: { size?: string; color?: string } } };

const ORDINALS: Record<string, number> = {
  first: 1, "1st": 1, one: 1, won: 1, "1": 1,
  second: 2, "2nd": 2, two: 2, to: 2, too: 2, "2": 2,
  third: 3, "3rd": 3, three: 3, tree: 3, "3": 3,
  fourth: 4, "4th": 4, four: 4, for: 4, "4": 4,
  fifth: 5, "5th": 5, five: 5, "5": 5,
  last: -1,
};

/**
 * "number 2", "the second one", "#2", "the 2nd one" → 2 (1-based). Speech
 * recognition often writes "number two" as "number to" or "number too", so
 * after "number" those count too.
 */
export function pickNumber(text: string): number | undefined {
  const m = text.match(/\b(?:number|no\.?|#|option|item)\s*(\d|one|won|two|to|too|three|tree|four|for|five)\b|\b(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th)\b|\bthe (one|two|three)\b|^\s*(\d)\s*$/i);
  const word = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4])?.toLowerCase();
  return word ? ORDINALS[word] : undefined;
}

/**
 * Words speech recognition commonly gets wrong for short shopping commands
 * (whole phrases only, so normal sentences are untouched): "by it" → "buy it",
 * "at it" → "add it", "my card" → "my cart".
 */
/**
 * Simple mode understands English requests. Hindi speech arrives in Devanagari
 * (often with English words written in it, like "रनिंग शूज़"), so common
 * shopping words are turned into English first. The AI, when it's on, reads
 * Hindi directly.
 */
const HINDI: [RegExp, string][] = [
  [/(\d+)\s*(?:डॉलर|डालर|रुपये|रुपए)?\s*से कम/g, "under $1 dollars"],
  [/मेरा ऑर्डर कहाँ है|ऑर्डर कहाँ है|मेरा ऑर्डर कहां है/g, "where is my order"],
  [/कितना (?:ख़र्च|खर्च|खर्चा) (?:किया|हुआ|हो गया)?/g, "how much have i spent"],
  [/(?:मेरे |मेरी )?(?:कार्ट|टोकरी) में क्या है/g, "what's in my cart"],
  [/के बारे में (?:बताओ|बताइए|बताइये|बताएं|बताएँ)|(?:बताओ|बताइए|बताइये)/g, " tell me about "],
  [/किस चीज़ से बना है|किससे बना है|किस से बना है/g, " what is it made of "],
  [/(?:जोड़|जोड)(?:ो|ें| दो| दीजिए| दें)|ऐड (?:करो|कर दो|करें)|डाल दो|डालो/g, " add "],
  [/(?:ख़रीद|खरीद)(?:ो|ें| लो| दो| लीजिए|ना है)/g, " buy it "],
  [/(?:हटा|निकाल)(?:ो| दो|ें| दीजिए)/g, " remove "],
  [/(?:साइज़|साइज|साईज)/g, " size "],
  [/नंबर/g, " number "],
  [/(?<=number\s+)एक/g, " 1 "],
  [/(?<=(?:number|size)\s+)दो/g, " 2 "],
  [/(?<=(?:number|size)\s+)तीन/g, " 3 "],
  [/(?<=(?:number|size)\s+)चार/g, " 4 "],
  [/(?<=(?:number|size)\s+)(?:पाँच|पांच)/g, " 5 "],
  [/इसे|इसको|यह वाला|ये वाला|वो वाला|उसे|यह|ये/g, " it "],
  [/रनिंग/g, " running "],
  [/(?:शूज़|शूज|जूते|जूता|जूतों)/g, " shoes "],
  [/(?:मोज़े|मोजे)/g, " socks "],
  [/(?:टी-शर्ट|टीशर्ट|टी शर्ट)/g, " t-shirt "],
  [/(?:किचन स्केल|रसोई (?:का )?तराज़ू|रसोई (?:का )?तराजू|तराज़ू|तराजू)/g, " kitchen scale "],
  [/(?:बोलने वाला|बोलने वाली|बोलने वाले|बोलता हुआ)/g, " talking "],
  [/(?:घड़ी|घडी)/g, " clock "],
  [/(?:मग|कप)/g, " mug "],
  [/कंबल/g, " blanket "],
  [/चाकू/g, " knife "],
  [/(?:पैन|कड़ाही|कढ़ाई)/g, " pan "],
  [/(?:काले|काला|काली)/g, " black "],
  [/(?:सफ़ेद|सफेद)/g, " white "],
  [/(?:नीले|नीला|नीली)/g, " blue "],
  [/लाल/g, " red "],
  [/(?:हरे|हरा|हरी)/g, " green "],
  [/(?:डॉलर|डालर)/g, " dollars "],
  [/(?:में|का|की|के|है|चाहिए|दिखाओ|दिखाइए|मुझे|कोई|कुछ|वाला|वाली|वाले|और)/g, " "],
];
// The dot under some letters (ड़, ज़) can be written two ways; compare without it.
const plain = (x: string) => x.normalize("NFD").replace(/\u093C/g, "");
const HINDI_PLAIN = HINDI.map(([re, en]) => [new RegExp(plain(re.source), re.flags), en] as const);

export function fromHindi(text: string): string {
  if (!/[\u0900-\u097F]/.test(text)) return text;
  let t = plain(text);
  for (const [re, en] of HINDI_PLAIN) t = t.replace(re, en);
  return t.replace(/[\u0900-\u097F]+/g, " ").replace(/\s+/g, " ").trim();
}

export function heardRight(t: string): string {
  return t
    .replace(/^(?:by|bye) (it|them|this|that|this one|that one|now)$/, "buy $1")
    .replace(/^(?:at|ad|and) (it|them|this|that|this one|that one)$/, "add $1")
    .replace(/^(?:at|ad) (it|them|number|the)\b/, "add $1")
    .replace(/\b(in|to|from|empty|clear) (my|the) card\b/, "$1 $2 cart");
}

const SIZE_WORDS: Record<string, string> = {
  one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12", thirteen: "13",
  small: "s", medium: "m", large: "l", "extra small": "xs", "extra large": "xl",
};
/** "size nine and a half" → "9.5"; "in a medium" → "m". */
function spokenSize(t: string): string | undefined {
  const m = t.match(/\bsize\s+(?:(?:to|of|is|in)\s+)?(\d+(?:\.\d)?|extra small|extra large|[a-z]+)(\s+and a half)?\b/) ?? t.match(/\bin (?:a |an )?(extra small|extra large|small|medium|large)\b/);
  if (!m) return undefined;
  const raw = m[1]!;
  const base = SIZE_WORDS[raw] ?? raw;
  return m[2] && /^\d+$/.test(base) ? `${base}.5` : base;
}

const COUNT_WORDS: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, couple: 2, pair: 2 };
/** "add two of number 2", "3 pairs", "add 2 of them" → 2. Undefined when no amount is said. */
export function pickQuantity(text: string): number | undefined {
  const m =
    text.match(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:of (?:them|those|these|it|that|number|the)|pairs?|pieces?|items?|units?|packs?)\b/i) ??
    text.match(/\b(?:add|buy|get|i'?ll take|i want)\s+(\d+|two|three|four|five|six|seven|eight|nine|ten)\b(?!\s*(?:dollars?|usd|bucks))/i) ??
    text.match(/\b(\d+)\s*(?:x|×)\b/i);
  if (!m) return undefined;
  const w = m[1]!.toLowerCase();
  const n = /^\d+$/.test(w) ? Number(w) : COUNT_WORDS[w];
  return n && n >= 1 && n <= 10 ? n : undefined;
}

const COLORS = ["black", "white", "grey", "gray", "blue", "red", "green", "navy", "brown", "pink", "yellow", "beige"];
const PRICE = /(?:under|below|less than|max|maximum|up to|within|budget(?: of)?|cheaper than)\s*(?:\$|rs\.?|₹)?\s*(\d+(?:\.\d+)?)\s*(?:dollars?|usd|bucks)?/;

/** Pull "size 9", "under $60", a colour, and the words to search for. */
export function parseRequest(text: string) {
  // Keep the dot in "9.5"; drop other punctuation.
  const t = text.toLowerCase().replace(/(?<!\d)\.|\.(?!\d)|[?!,]/g, " ");
  const size = spokenSize(t);
  const price = t.match(PRICE)?.[1];
  const color = COLORS.find((c) => new RegExp(`\\b${c}\\b`).test(t));
  const query = t
    .replace(/\bsize\s+(?:(?:to|of|is|in)\s+)?(?:\d+(?:\.\d)?|extra small|extra large|[a-z]+)(?:\s+and a half)?/g, " ")
    .replace(/\bin (?:a |an )?(?:extra small|extra large|small|medium|large)\b/g, " ")
    .replace(PRICE, " ")
    .replace(/\b(i need|i want|i'?m looking for|looking for|find me|find|show me|search for|search|can you|could you|please|do you have|have you got|is there|are there|some|something|anything|a pair of|pair of|a|an|the|for me|get me|i'?d like)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return { query, size, maxPrice: price ? Number(price) : undefined, color };
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

const HELP = {
  en: "I'm in simple mode, so short requests work best. Try: running shoes under 60. Tell me about number 2. Add it in size 9. What's in my cart. Buy it. Cancel that. Where's my order.",
  hi: "मैं अभी सरल मोड में हूँ, इसलिए छोटे वाक्य बोलिए। जैसे: रनिंग शूज़ 60 डॉलर से कम। नंबर एक के बारे में बताओ। साइज़ 9 में जोड़ो। कार्ट में क्या है। खरीदो। रद्द करो।",
};

type Ctx = { userId: string; lang: Lang; conversationId: string; text: string; events: AgentEvent[] };

const has = (t: string, re: RegExp) => re.test(t);
const variantText = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ");

/** One turn in simple mode. Returns the reply and what to remember. */
export async function basicTurn(ctx: Ctx): Promise<{ reply: string; memory: BasicMemory; orderFacts: boolean }> {
  const orderFacts = { seen: false };
  const tools = createTools({ userId: ctx.userId, lang: ctx.lang, model: undefined as never, events: ctx.events, orderFacts });
  const run = <K extends keyof typeof tools>(name: K, input: unknown) =>
    (tools[name] as unknown as { execute: (i: unknown, o: { toolCallId: string; messages: [] }) => Promise<any> }).execute(input, { toolCallId: `basic-${String(name)}`, messages: [] });

  const mem: BasicMemory["basic"] = (await lastMemory(ctx.conversationId)) ?? { results: [] };
  const remember = (patch: Partial<BasicMemory["basic"]> = {}): BasicMemory => ({ basic: { ...mem, ...patch } });
  // Curly quotes around the things to say: “add it” reads better on screen and sounds the same.
  const done = (reply: string, patch?: Partial<BasicMemory["basic"]>) => ({ reply: reply.replace(/"([^"]+)"/g, "“$1”"), memory: remember(patch), orderFacts: orderFacts.seen });

  // Greetings, thanks and "cancel" in Hindi are understood as they are; everything else goes through fromHindi.
  const hindiCommand = /^(नमस्ते|हेलो|धन्यवाद|शुक्रिया|मदद)|रद्द|कैंसल/.test(ctx.text.trim().normalize("NFC"));
  const said = hindiCommand ? ctx.text : fromHindi(ctx.text);
  const t = heardRight(said.trim().toLowerCase().replace(/[?!.]+$/g, "").replace(/’/g, "'"));
  const n = pickNumber(t);
  const byNumber = n ? (n === -1 ? mem.results.at(-1) : mem.results[n - 1]) : undefined;
  // By name, as the product cards' buttons say it: "Tell me more about the Trail Runner 2", "Add the Trail Runner 2 to my cart".
  let byName = [...mem.results].sort((a, b) => b.title.length - a.title.length).find((r) => t.includes(r.title.toLowerCase()));
  const named = t.match(/^(?:tell me more about|add) the (.+?)(?: to my cart)?$/)?.[1];
  if (!byName && named) {
    // A card from earlier in the conversation: look the product up by its exact name.
    const before = ctx.events.length;
    const found = ((await run("search_products", { query: named })).results ?? []) as Hit[];
    ctx.events.splice(before); // an internal lookup: don't show its results as cards
    const hit = found.find((h) => h.title.toLowerCase() === named);
    if (hit) {
      byName = { id: hit.product_id, title: hit.title, options: hit.options };
      mem.results = [...mem.results, byName];
    }
  }
  // "number 5" when there were 3 results means nothing is chosen (we ask), not "the last one we talked about".
  const chosen = n !== undefined ? byNumber : (byName ?? mem.results.find((r) => r.id === mem.focus) ?? (mem.results.length === 1 ? mem.results[0] : undefined));
  const wantsSomething = /\b(it|that|this|this one|that one|them)\b/.test(t) || n !== undefined || byName !== undefined;

  /** Ask which product when "it" is unclear. */
  const which = () => {
    if (n && !byNumber)
      return done(
        mem.results.length === 1
          ? `I only found one just now: the ${mem.results[0]!.title}. Say "tell me more" or "add it".`
          : mem.results.length
            ? `I only found ${mem.results.length} just now. Say a number from 1 to ${mem.results.length}.`
            : "Tell me what you're looking for first, for example: running shoes under 60.",
      );
    if (mem.results.length === 0) return done("Tell me what you're looking for first, for example: running shoes under 60.");
    return done(`Which one? ${mem.results.map((r, i) => `Number ${i + 1} is the ${r.title}.`).join(" ")}`);
  };

  /** "9" → "9", "m" → "M (US 8-10)": the store's own spelling of a choice, when we know it. */
  const matchOptions = (r: Result, want: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(want).map(([k, v]) => {
        const w = v.toLowerCase();
        const vals = r.options[k];
        return [k, vals?.find((x) => x.toLowerCase() === w) ?? vals?.find((x) => x.toLowerCase().startsWith(`${w} `) || x.toLowerCase().startsWith(`${w}(`)) ?? v];
      }),
    );

  /** Options from what the person said now, or earlier in the search. */
  const optionsFor = (r: Result, said: string) => {
    const p = parseRequest(said);
    const size = p.size ?? said.match(/^\s*(?:in )?([a-z0-9.]+)\s*$/)?.[1] ?? said.match(/\bin (?:size )?([0-9]+(?:\.5)?|xs|s|m|l|xl|xxl)\b/)?.[1] ?? mem.wanted?.size;
    const color = p.color ?? mem.wanted?.color;
    const out: Record<string, string> = {};
    for (const [name, values] of Object.entries(r.options)) {
      if (values.length === 1) out[name] = values[0]!;
      const want = name.toLowerCase() === "size" ? size : name.toLowerCase() === "color" ? color : undefined;
      if (!want) continue;
      const w = want.toLowerCase();
      const hit = values.find((v) => v.toLowerCase() === w) ?? values.find((v) => v.toLowerCase().startsWith(`${w} `) || v.toLowerCase().startsWith(`${w}(`));
      if (hit) out[name] = hit;
    }
    return out;
  };

  const addProduct = async (r: Result, said: string) => {
    const opts = optionsFor(r, said);
    const missing = Object.keys(r.options).find((k) => !opts[k]);
    if (missing) return done(`Which ${missing} would you like for the ${r.title}? You can choose ${r.options[missing]!.join(", ")}.`, { focus: r.id });
    const qty = pickQuantity(said) ?? 1;
    const res = await run("add_to_cart", { product_id: r.id, options: opts, quantity: qty });
    if ("error" in res) return done(res.error, { focus: r.id });
    const what = `${r.title}${Object.keys(opts).length ? `, ${variantText(opts)}` : ""}`;
    const line = res.cart.items.find((i: { product_id: string; options: Record<string, string> }) => i.product_id === r.id && Object.entries(opts).every(([k, v]) => i.options[k] === v));
    // Saying "add it" twice is easy to do by voice: make a second one obvious.
    if (line && line.quantity > qty)
      return done(`Added another ${what}. You now have ${line.quantity} of them, and your cart is ${res.cart.total} with tax and delivery. If you only wanted one, say "remove it" and add it again.`, { focus: r.id });
    if (qty > 1) return done(`Added ${qty} of the ${what}. Your cart is now ${res.cart.total} with tax and delivery. Say "buy it" when you're ready, or keep shopping.`, { focus: r.id });
    return done(`Added the ${what}. Your cart is now ${res.cart.total} with tax and delivery. Say "buy it" when you're ready, or keep shopping.`, { focus: r.id });
  };

  // ── Small talk and help ───────────────────────────────────────────────
  if (/^(hi|hello|hey|hiya|good (morning|afternoon|evening)|namaste|नमस्ते|हेलो)\b/.test(t) && t.split(/\s+/).length <= 4)
    return done(ctx.lang === "hi" ? `नमस्ते! आपको क्या चाहिए? ${HELP.hi}` : `Hello! What can I find for you? ${HELP.en}`);
  if (/^(thanks|thank you|thank u|ok|okay|cool|great|nice|perfect|good|bye|goodbye|that's all|no thanks|nothing|धन्यवाद|शुक्रिया)\b/.test(t) && t.split(/\s+/).length <= 4)
    return done(ctx.lang === "hi" ? "आपका स्वागत है। और कुछ चाहिए तो बताइए।" : "You're welcome. Tell me if you need anything else.");
  if (/^(help|what can (i|you) (say|do)|how does this work|मदद)\b/.test(t)) return done(HELP[ctx.lang]);

  if (/^(start (over|again)|new search|clear (this|that|the search)|forget (it|that)|never ?mind)\b/.test(t))
    return done("Okay, let's start again. What are you looking for?", { results: [], focus: undefined, wanted: {} });
  if (has(t, /\b(empty|clear) (my |the )?(cart|basket)\b/)) {
    const view = await run("view_cart", {});
    const cart = view.carts?.[0];
    if (!cart) return done("Your cart is already empty.");
    for (const i of cart.items) await run("remove_from_cart", { cart_id: cart.cart_id, product_id: i.product_id });
    return done("Your cart is empty now.");
  }

  // ── Orders and money ──────────────────────────────────────────────────
  if (has(t, /\b(cancel|undo)\b|रद्द|कैंसल/) && !has(t, /\bdon'?t\b|\bdo not\b/)) {
    const r = await run("cancel_order", {});
    return done("error" in r ? r.error : r.message);
  }
  if (has(t, /\b(return|send (it )?back|refund)\b/) && has(t, /\b(order|it|my)\b/) && !has(t, /\b(policy|policies)\b/)) {
    return done(`To return a paid order, open My orders and choose "Start a return". The store refunds to your PayPal.`);
  }
  if (has(t, /\b(my orders?|order status|where('?s| is) my|track(ing)?|has my .* (arrived|shipped)|did my order)\b/)) {
    const r = await run("order_status", { limit: 3 });
    if (r.orders.length === 0) return done("You don't have any orders yet.");
    const lines = r.orders.map((o: any) => `${o.items.join(" and ")} from ${o.store}, ${o.amount}: ${o.status}${o.cancel_until ? `, you can cancel until ${o.cancel_until}` : ""}${o.tracking ? `. ${o.tracking}` : ""}.`);
    return done(`Your latest ${r.orders.length === 1 ? "order" : "orders"}: ${lines.join(" ")}`);
  }
  if (has(t, /\b(spent|spending|my budget|my limit|limits?|how much (have|did) i|left to spend)\b/)) {
    const r = await run("spending_summary", {});
    return done(`This month you've spent ${r.this_month}. You have ${r.left_this_month} left of your ${r.monthly_limit} monthly limit, and the most for one order is ${r.per_order_limit}.`);
  }

  // ── Cart ──────────────────────────────────────────────────────────────
  if (has(t, /\b(remove|delete|take (it )?(out|off)|don'?t want|get rid of)\b/)) {
    const view = await run("view_cart", {});
    const cart = view.carts?.[0];
    if (!cart) return done("Your cart is already empty.");
    const words = (title: string) => title.toLowerCase().split(/[^a-z0-9]+/).filter((w: string) => w.length >= 4 || /^\d+$/.test(w));
    const named = cart.items.filter((i: any) => words(i.title).some((w: string) => new RegExp(`\\b${w}`).test(t)));
    // What's left after the verb and little words, e.g. "the scale" → "scale".
    const rest = t.replace(/\b(remove|delete|take|out|off|of|from|my|the|a|an|it|that|this|them|one|please|cart|basket|don'?t want|get rid|number|no|\d+|first|second|third|last)\b/g, " ").trim();
    const pointed = (byNumber && cart.items.find((i: any) => i.product_id === byNumber.id)) ?? (byName && cart.items.find((i: any) => i.product_id === byName.id));
    const target =
      pointed ??
      (named.length === 1 ? named[0] : undefined) ??
      (!rest && chosen ? cart.items.find((i: any) => i.product_id === chosen.id) : undefined) ??
      (!rest && cart.items.length === 1 ? cart.items[0] : undefined);
    const list = cart.items.map((i: any) => i.title).join(", ");
    if (!target && rest && named.length === 0) return done(`Your cart doesn't have that. It has: ${list}.`);
    if (!target) return done(`Which item should I remove? Your cart has: ${list}.`);
    const r = await run("remove_from_cart", { cart_id: cart.cart_id, product_id: target.product_id });
    if ("error" in r) return done(r.error);
    return done(r.cart.items.length ? `Removed the ${target.title}. Your cart is now ${r.cart.total}.` : `Removed the ${target.title}. Your cart is empty now.`);
  }
  if (has(t, /\b(change|switch|swap|make it|instead)\b/) && !has(t, /\badd\b/) && has(t, /\b(size|colou?r|\d+|black|white|grey|gray|blue|red|green|navy|brown|pink|yellow|beige|small|medium|large)\b/)) {
    const view = await run("view_cart", {});
    const cart = view.carts?.[0];
    if (!cart) return done("Your cart is empty, so there's nothing to change. Add something first.");
    const line = (byName && cart.items.find((i: any) => i.product_id === byName.id)) ?? (chosen && cart.items.find((i: any) => i.product_id === chosen.id)) ?? (cart.items.length === 1 ? cart.items[0] : undefined);
    if (!line) return done(`Which item should I change? Your cart has: ${cart.items.map((i: any) => i.title).join(", ")}.`);
    const result = mem.results.find((r) => r.id === line.product_id) ?? { id: line.product_id, title: line.title, options: {} as Record<string, string[]> };
    const p = parseRequest(t);
    const size = p.size ?? t.match(/\bto\s+(?:size\s+)?([a-z0-9.]+)\s*$/)?.[1] ?? t.match(/\b(\d+(?:\.5)?)\b/)?.[1];
    const next: Record<string, string> = { ...line.options };
    if (p.color && "color" in next) next.color = p.color;
    else if (size && "size" in next) next.size = size;
    else return done(`What should I change it to? For example: change the size to 9.`);
    // Add the new choice first (that checks it exists), then take the old one out.
    const wanted = matchOptions(result, next);
    if (variantText(wanted) === variantText(line.options)) return done(`The ${line.title} is already ${variantText(line.options)}.`, { focus: line.product_id });
    const added = await run("add_to_cart", { product_id: line.product_id, options: wanted, quantity: line.quantity });
    if ("error" in added) return done(added.error, { focus: line.product_id });
    const after = await run("remove_from_cart", { cart_id: cart.cart_id, product_id: line.product_id, options: line.options });
    const total = "error" in after ? added.cart.total : after.cart.total;
    const now = ("error" in after ? added : after).cart.items.find((i: any) => i.product_id === line.product_id && i.quantity === line.quantity);
    return done(`Done: the ${line.title} is now ${variantText(now?.options ?? wanted)}. Your cart is ${total} with tax and delivery.`, { focus: line.product_id });
  }

  if (has(t, /\b(cart|basket)\b/) && !has(t, /\badd\b/)) {
    const r = await run("view_cart", {});
    if (!r.carts?.length) return done("Your cart is empty.");
    const c = r.carts[0];
    return done(`In your cart from ${c.store}: ${c.items.map((i: any) => `${i.quantity > 1 ? `${i.quantity} × ` : ""}${i.title}${Object.keys(i.options).length ? `, ${variantText(i.options)}` : ""}, ${i.line_price}`).join("; ")}. Total ${c.total} with tax and delivery. Say "buy it" when you're ready.`);
  }

  // ── Buy → read-back (the person still has to confirm) ─────────────────
  if (has(t, /\b(buy|checkout|check out|purchase|order it|order this|place (the |my )?order|pay|i'?ll take it)\b|खरीद/)) {
    const view = await run("view_cart", {});
    const inCart = (id: string) => view.carts?.some((c: any) => c.items.some((i: any) => i.product_id === id));
    if (chosen && wantsSomething && !inCart(chosen.id)) {
      const added = await addProduct(chosen, t);
      if (!added.reply.startsWith("Added")) return added;
    } else if (!view.carts?.length && chosen) {
      const added = await addProduct(chosen, t);
      if (!added.reply.startsWith("Added")) return added;
    }
    const r = await run("request_readback", {});
    if ("error" in r) return done(r.error === "The cart is empty." ? `Your cart is empty. Find something first, then say "add it".` : r.error);
    if (r.status === "blocked") return done(r.reason);
    return done("Here is your order. Please check it, then press Confirm, or say confirm.");
  }

  // ── Add to cart ───────────────────────────────────────────────────────
  if (has(t, /\b(add|i'?ll take|i want (it|that|this|number|the)|get (it|that|this|number))\b/)) {
    if (!chosen) return which();
    return addProduct(chosen, t);
  }

  // Answering "Which size?" with just a size: "size 9", "9", "medium"
  if (mem.focus && /^(size\s+)?[a-z0-9.]+$/.test(t) && !n) {
    const focus = mem.results.find((r) => r.id === mem.focus);
    if (focus && Object.keys(focus.options).length) return addProduct(focus, t.replace(/^size\s+/, "size "));
  }

  if (has(t, /\b(cheapest|least expensive|lowest price|most expensive|priciest)\b/) && mem.results.some((r) => r.price)) {
    const priced = mem.results.map((r, i) => ({ r, i, cents: Math.round(Number((r.price ?? "").replace(/[^0-9.]/g, "")) * 100) })).filter((x) => x.cents > 0);
    const most = has(t, /\b(most expensive|priciest)\b/);
    const pick = priced.sort((a, b) => (most ? b.cents - a.cents : a.cents - b.cents))[0]!;
    return done(`The ${most ? "most expensive" : "cheapest"} is number ${pick.i + 1}, the ${pick.r.title}, at ${pick.r.price}. Say "tell me more" or "add it".`, { focus: pick.r.id });
  }

  // "Do you have number 2 in black?", "does it come in size 10?"
  const wants = parseRequest(t);
  const pointsAtOne = n !== undefined || byName !== undefined || /\b(it|they|them|this|that|this one|that one)\b/.test(t);
  if ((wants.color || wants.size || /\bin (size )?\d/.test(t)) && pointsAtOne && /^(do|does|is|are|can|have|has|got|any)\b/.test(t)) {
    if (!chosen) return which();
    const r = await run("get_product", { product_id: chosen.id });
    if ("error" in r) return done(r.error);
    const options = r.options_to_choose as Record<string, string[]>;
    const facts = r.facts as Record<string, string>;
    const keep = { focus: chosen.id };
    if (wants.color) {
      const colours = options.color;
      if (colours) {
        const hit = colours.find((c: string) => c.toLowerCase() === wants.color);
        return done(hit ? `Yes, the ${r.title} comes in ${hit}. Say "add it in ${hit.toLowerCase()}".` : `No, the ${r.title} comes in ${colours.join(", ")}.`, keep);
      }
      const colour = facts.color ?? facts.colour;
      if (colour) return done(colour.toLowerCase().includes(wants.color) ? `Yes, the ${r.title} is ${colour}.` : `No, the ${r.title} only comes in ${colour}.`, keep);
      return done(`The store didn't list a colour for the ${r.title}.`, keep);
    }
    const size = wants.size ?? t.match(/\bin (?:size )?([0-9]+(?:\.5)?)/)?.[1];
    if (size && options.size) {
      const hit = options.size.find((v: string) => v.toLowerCase() === size || v.toLowerCase().startsWith(`${size} `));
      return done(hit ? `Yes, the ${r.title} comes in size ${hit}. Say "add it in size ${size}".` : `No, the ${r.title} comes in sizes ${options.size.join(", ")}.`, keep);
    }
    if (size) return done(`The ${r.title} doesn't come in sizes.`, keep);
  }

  // ── Questions about a product ─────────────────────────────────────────
  const asksPhoto = has(t, /\b(photo|picture|image|look like|looks like|describe)\b/);
  // A question about a product (not a new search like "black shoes size 9"):
  // it names "it"/"number 2", or starts like a question.
  const questionish = wantsSomething || /^(what|what's|whats|does|do|is|are|how|when|tell|which|can|describe|compare|more)\b/.test(t);
  const asksFacts = questionish && has(t, /\b(made of|material|fabric|size chart|sizes|what size|which size|fit|return|returns|refund policy|deliver|delivery|arrive|shipping|price|cost|how much is|colou?rs?|weight|tell me|more about|details|about|what is it|which is better|compare|difference|in stock|stock|available|availability)\b/);
  if (asksPhoto || asksFacts || (n !== undefined && t.split(/\s+/).length <= 4)) {
    if (has(t, /\b(compare|which is better|difference)\b/) && mem.results.length >= 2) {
      const r = await run("compare_products", { product_ids: mem.results.slice(0, 3).map((x) => x.id) });
      const lines = r.products.map((p: any, i: number) => {
        const known = Object.entries(p.facts as Record<string, string>).filter(([, v]) => v !== "not provided").slice(0, 3);
        return `Number ${i + 1}, ${p.title}: ${p.price}, arrives ${p.arrives}.${known.length ? ` ${known.map(([k, v]) => `${k}: ${v}`).join(". ")}.` : ""}`;
      });
      return done(lines.join(" "));
    }
    if (!chosen) return which();
    if (asksPhoto) {
      const r = await run("describe_photo", { product_id: chosen.id }).catch(() => ({ source: "none", description: "I can't look at photos in simple mode, and the store didn't describe this one." }));
      return done(r.say_first ? `${r.say_first}: ${r.description}` : r.description, { focus: chosen.id });
    }
    const r = await run("get_product", { product_id: chosen.id });
    if ("error" in r) return done(r.error);
    const facts = r.facts as Record<string, string>;
    const options = r.options_to_choose as Record<string, string[]>;
    const keep = { focus: chosen.id };
    if (has(t, /\b(in stock|stock|available|availability)\b/))
      return done(`${r.store} lists the ${r.title} for sale now, so you can order it. It should arrive ${r.arrives}.`, keep);
    if (has(t, /\b(made of|material|fabric)\b/)) return done(facts.material ? `The ${r.title} is made of: ${facts.material}.` : `The store didn't say what the ${r.title} is made of. I've let them know.`, keep);
    if (has(t, /\b(size chart|fit)\b/)) return done(`${r.size_chart}${facts.fit ? ` Fit: ${facts.fit}.` : ""}`, keep);
    if (has(t, /\b(sizes|what size|which size)\b/)) return done(options.size ? `The ${r.title} comes in sizes ${options.size.join(", ")}. ${r.size_chart}` : `The ${r.title} doesn't come in sizes.`, keep);
    if (has(t, /\b(return|returns|refund policy)\b/)) return done(`Returns: ${r.return_policy}`, keep);
    if (has(t, /\b(deliver|delivery|arrive|shipping)\b/)) return done(`It should arrive ${r.arrives}. Delivery: ${r.delivery}.`, keep);
    if (has(t, /\b(price|cost|how much is)\b/)) return done(`The ${r.title} is ${r.price}, before tax and delivery.`, keep);
    if (has(t, /\bcolou?rs?\b/)) return done(options.color ? `It comes in ${options.color.join(", ")}.` : facts.color ? `Colour: ${facts.color}.` : `The store didn't list the colour.`, keep);
    const factLine = Object.entries(facts).map(([k, v]) => `${k}: ${v}`).join(". ");
    const optLine = Object.entries(options).map(([k, v]) => `${k} options: ${v.join(", ")}`).join(". ");
    return done(
      `${r.title} from ${r.store}, ${r.price}. ${factLine ? `${factLine}. ` : ""}${optLine ? `${optLine}. ` : ""}Arrives ${r.arrives}.${r.missing_information.length ? ` The store didn't provide: ${r.missing_information.join("; ").toLowerCase()}.` : ""} Say "add it" to put it in your cart.`,
      keep,
    );
  }

  // "it" with nothing to point at
  if (wantsSomething && /^(it|that|this|this one|that one)$/.test(t)) return which();

  // ── Otherwise: search ─────────────────────────────────────────────────
  const { query, size, maxPrice, color } = parseRequest(said);
  if (!query && !maxPrice) return done(HELP[ctx.lang]);
  const r = await run("search_products", { query: query || "everything", size, color, max_price_dollars: maxPrice });
  const hits = (r.results ?? []) as Hit[];
  const what = query ? `"${query}"` : "that";
  if (hits.length === 0) return done(`I couldn't find ${what}${maxPrice ? ` under $${maxPrice}` : ""}${size ? ` in size ${size}` : ""}. Try different words${maxPrice ? " or a higher price" : ""}.`);
  const list = hits.map((h, i) => `Number ${i + 1}: ${h.title}, ${h.price}, from ${h.store}.`).join(" ");
  const first = hits[0]!;
  const sizes = first.options.size;
  const example = sizes && !size ? sizes[Math.floor(sizes.length / 2)]!.split(" ")[0] : undefined; // a middle size, as an example
  const tip = hits.length === 1 ? `Say "tell me more", or "add it${example ? ` in size ${example}` : ""}".` : `Say "tell me about number 1", or "add number 1${example ? `, size ${example}` : ""}".`;
  return done(`I found ${hits.length}. ${list} ${tip}`, {
    results: hits.map((h) => ({ id: h.product_id, title: h.title, options: h.options, price: h.price })),
    focus: hits.length === 1 ? first.product_id : undefined,
    wanted: { size, color },
  });
}
