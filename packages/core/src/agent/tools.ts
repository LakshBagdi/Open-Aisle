/**
 * The agent's tools. Each one is a small, checked doorway into our code.
 *
 * What the agent CAN do: search, read product facts, describe photos, compare,
 * check a price, build the cart, ask for the read-back, cancel during the undo
 * window, check orders and spending, start a return.
 *
 * What it CAN'T do: pay. There is no tool for that. Paying needs the person's
 * Confirm in the app (see rules/confirmation.ts).
 *
 * Tool results speak in ready-to-say strings ("$54.99", "Thursday, October 23")
 * so the model repeats exact values instead of doing maths.
 */
import { generateText, tool, type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { recordBarrierHits } from "../barriers";
import { addToCart, CartError, computeTotals, getCart, listOpenCarts, removeFromCart, setQuantity } from "../cart";
import { channel3Available, getProductWithStore, priceComparison, searchCatalog } from "../catalog";
import { getDb } from "../db";
import { spendingRules, stores, type Cart, type Product, type Store } from "../db/schema";
import { formatMoney } from "../money";
import { buildReadBack, cancelOrder, latestHeldOrder, listOrders, OrderError, spendingSummary, startReturn } from "../orders";
import { cartFingerprint, checkSpending } from "../rules";
import type { Lang } from "../i18n";

export type AgentEvent =
  | { type: "readback"; cartId: string; fingerprint: string; storeName: string; lines: string[]; totalLine: string; deliveryLine: string; undoLine: string; spoken: string; blockedReason?: string }
  | { type: "cart_updated"; cartId: string; itemCount: number; total: string }
  | { type: "order_cancelled"; orderId: string };

export type ToolContext = {
  userId: string;
  lang: Lang;
  model: LanguageModel;
  events: AgentEvent[];
  /** Becomes true when a tool reports a real order status this turn. */
  orderFacts: { seen: boolean };
};

const money = (c: number, cur = "USD") => formatMoney(c, cur);

function deliveryBy(store: Store) {
  return computeTotals(store, []).deliveryEstimate;
}

function keyFacts(p: Product): string[] {
  return Object.entries(p.attributes)
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${v}`);
}

function cartSummary(cart: Cart, storeName: string) {
  const t = cart.totals!;
  return {
    cart_id: cart.id,
    store: storeName,
    items: cart.items.map((i) => ({
      product_id: i.productId,
      title: i.title,
      options: i.variant,
      quantity: i.quantity,
      line_price: money(i.unitPriceCents * i.quantity),
    })),
    subtotal: money(t.subtotalCents),
    tax: money(t.taxCents),
    delivery: t.deliveryCents === 0 ? "free" : money(t.deliveryCents),
    total: money(t.totalCents),
    arrives: t.deliveryEstimate,
  };
}

async function storeById(storeId: string) {
  const [s] = await getDb().select().from(stores).where(eq(stores.id, storeId)).limit(1);
  return s!;
}

async function allowedStoreIds(userId: string) {
  const [r] = await getDb().select({ ids: spendingRules.allowedStoreIds }).from(spendingRules).where(eq(spendingRules.userId, userId)).limit(1);
  return r?.ids ?? [];
}

/** Errors the person should hear become tool results, not crashes. */
async function friendly<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CartError || err instanceof OrderError) return { error: err.message };
    throw err;
  }
}

const id = z.string().describe("An id exactly as returned by a previous tool result");

export function createTools(ctx: ToolContext) {
  return {
    search_products: tool({
      description: "Find products. Returns at most 3, best first. Use the person's own words; add max price, size or colour if they said them.",
      inputSchema: z.object({
        query: z.string().min(1).describe("What the person is looking for, e.g. 'black running shoes'"),
        max_price_dollars: z.number().positive().optional(),
        size: z.string().optional(),
        color: z.string().optional(),
        category: z.enum(["shoes", "clothing", "kitchen", "home"]).optional(),
      }),
      execute: async (input) => {
        const hits = await searchCatalog({
          query: input.query,
          maxPriceCents: input.max_price_dollars ? Math.round(input.max_price_dollars * 100) : undefined,
          size: input.size,
          color: input.color,
          category: input.category,
          storeIds: await allowedStoreIds(ctx.userId),
          limit: 3,
        });
        if (hits.length === 0) return { results: [], note: "Nothing matched. Suggest trying different words or a higher price." };
        return {
          results: hits.map(({ product: p, store: s }) => ({
            product_id: p.id,
            title: p.title,
            brand: p.brand,
            store: s.name,
            price: money(p.priceCents, p.currency),
            arrives: deliveryBy(s),
            key_facts: keyFacts(p),
            options: p.options,
            photo_has_description: p.images.some((i) => i.alt.trim().length > 0),
          })),
        };
      },
    }),

    get_product: tool({
      description: "All facts the store gives about one product: description, facts, options, size chart, return policy, delivery.",
      inputSchema: z.object({ product_id: id }),
      execute: async ({ product_id }) => {
        const row = await getProductWithStore(product_id);
        if (!row) return { error: "No product with that id." };
        const { product: p, store: s } = row;
        const missing = await recordBarrierHits(p, s);
        return {
          product_id: p.id,
          title: p.title,
          brand: p.brand,
          store: s.name,
          price: money(p.priceCents, p.currency),
          in_stock: p.inStock,
          description: p.description,
          facts: p.attributes,
          options_to_choose: p.options,
          size_chart: p.sizeChart ?? "The store did not provide a size chart.",
          return_policy: p.returnPolicy ?? s.returnPolicy ?? "The store did not provide a return policy.",
          delivery: s.deliveryCents === 0 ? "free" : `${money(s.deliveryCents)}${s.freeDeliveryOverCents ? `, free over ${money(s.freeDeliveryOverCents)}` : ""}`,
          arrives: deliveryBy(s),
          missing_information: missing.map((m) => m.detail),
        };
      },
    }),

    describe_photo: tool({
      description: "Describe a product's photo for someone who can't see it. Always tell the person where the description came from.",
      inputSchema: z.object({ product_id: id }),
      execute: async ({ product_id }) => {
        const row = await getProductWithStore(product_id);
        if (!row) return { error: "No product with that id." };
        const { product: p, store: s } = row;
        const img = p.images[0];
        if (!img) return { source: "none", description: "This product has no photo." };
        if (img.alt.trim()) return { source: "store_description", description: img.alt, say_first: "The store describes the photo as" };
        await recordBarrierHits(p, s);
        if (!/^https?:\/\//.test(img.url)) {
          return { source: "none", description: "The store didn't describe this photo, and I can't see it clearly. The store has been told." };
        }
        const res = await generateText({
          model: ctx.model,
          maxOutputTokens: 200,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Describe this product photo for a blind shopper in two short sentences: what it is, its colours, and anything notable. Product: "${p.title}". Only describe what you can see. If unsure, say so.` },
                { type: "file", mediaType: "image", data: img.url },
              ],
            },
          ],
        });
        return { source: "ai_from_photo", description: res.text, say_first: "From the photo, and this may be wrong", confidence: "medium" };
      },
    }),

    compare_products: tool({
      description: "Compare 2 or 3 products side by side on the same facts.",
      inputSchema: z.object({ product_ids: z.array(id).min(2).max(3) }),
      execute: async ({ product_ids }) => {
        const rows = (await Promise.all(product_ids.map(getProductWithStore))).filter((r): r is NonNullable<typeof r> => Boolean(r));
        const keys = [...new Set(rows.flatMap((r) => Object.keys(r.product.attributes)))];
        return {
          products: rows.map(({ product: p, store: s }) => ({
            product_id: p.id,
            title: p.title,
            price: money(p.priceCents, p.currency),
            arrives: deliveryBy(s),
            facts: Object.fromEntries(keys.map((k) => [k, p.attributes[k] ?? "not provided"])),
          })),
        };
      },
    }),

    price_check: tool({
      description: "Is this a fair price? Compares the product's price with similar products across the web (Channel3).",
      inputSchema: z.object({ product_id: id }),
      execute: async ({ product_id }) => {
        const row = await getProductWithStore(product_id);
        if (!row) return { error: "No product with that id." };
        if (!channel3Available()) return { available: false, note: "Price comparison isn't switched on." };
        const r = await priceComparison(`${row.product.brand ?? ""} ${row.product.title}`.trim(), row.product.priceCents);
        if (!r.enough) return { available: true, note: "Not enough similar products to compare." };
        const verdict = { below_typical: "lower than typical", typical: "about typical", above_typical: "higher than typical" }[r.verdict];
        return {
          available: true,
          our_price: money(row.product.priceCents),
          compared_with: `${r.compared} similar products`,
          lowest: money(r.lowCents),
          typical: money(r.medianCents),
          highest: money(r.highCents),
          verdict,
          source: "Channel3",
        };
      },
    }),

    add_to_cart: tool({
      description: "Add a product to the cart. Required options (like size) must be chosen first.",
      inputSchema: z.object({
        product_id: id,
        options: z.record(z.string(), z.string()).default({}).describe('e.g. {"size": "9"}'),
        quantity: z.number().int().min(1).max(10).default(1),
      }),
      execute: ({ product_id, options, quantity }) =>
        friendly(async () => {
          const cart = await addToCart(ctx.userId, product_id, options, quantity);
          const store = await storeById(cart.storeId);
          ctx.events.push({ type: "cart_updated", cartId: cart.id, itemCount: cart.items.length, total: money(cart.totals!.totalCents) });
          return { added: true, cart: cartSummary(cart, store.name) };
        }),
    }),

    remove_from_cart: tool({
      description: "Remove a product from a cart, or change its quantity (0 removes it).",
      inputSchema: z.object({ cart_id: id, product_id: id, quantity: z.number().int().min(0).max(10).optional() }),
      execute: ({ cart_id, product_id, quantity }) =>
        friendly(async () => {
          const cart = quantity === undefined ? await removeFromCart(ctx.userId, cart_id, product_id) : await setQuantity(ctx.userId, cart_id, product_id, quantity);
          const store = await storeById(cart.storeId);
          ctx.events.push({ type: "cart_updated", cartId: cart.id, itemCount: cart.items.length, total: money(cart.totals!.totalCents) });
          return { updated: true, cart: cartSummary(cart, store.name) };
        }),
    }),

    view_cart: tool({
      description: "What is in the person's carts right now (one cart per store).",
      inputSchema: z.object({}),
      execute: async () => {
        const list = await listOpenCarts(ctx.userId);
        if (list.length === 0) return { carts: [], note: "The cart is empty." };
        return { carts: await Promise.all(list.map(async (c) => cartSummary(c, (await storeById(c.storeId)).name))) };
      },
    }),

    request_readback: tool({
      description:
        "When the person wants to buy: the app reads the exact order aloud and shows Confirm, Change and Cancel. You cannot confirm for them. After calling this, briefly say the order is being read back, and wait.",
      inputSchema: z.object({ cart_id: id.optional() }),
      execute: ({ cart_id }) =>
        friendly(async () => {
          let cart: Cart;
          if (cart_id) cart = await getCart(ctx.userId, cart_id);
          else {
            const open = await listOpenCarts(ctx.userId);
            if (open.length === 0) return { error: "The cart is empty." };
            if (open.length > 1) return { error: "There are carts at more than one store. Ask which one to order first.", carts: open.map((c) => c.id) };
            cart = open[0]!;
          }
          if (cart.status !== "open" || cart.items.length === 0) return { error: "That cart is empty or already ordered." };
          const store = await storeById(cart.storeId);
          const [rules] = await getDb().select().from(spendingRules).where(eq(spendingRules.userId, ctx.userId)).limit(1);
          const rb = buildReadBack(cart, store, rules?.undoWindowSeconds ?? 600, ctx.lang);
          // Check limits now, so the person hears a problem before confirming, not after.
          const check = await checkSpending(ctx.userId, cart.storeId, cart.totals!.totalCents, cart.totals!.currency);
          const blockedReason = check.ok ? undefined : check.reason;
          ctx.events.push({ type: "readback", cartId: cart.id, fingerprint: cartFingerprint(cart), storeName: rb.storeName, lines: rb.lines, totalLine: rb.totalLine, deliveryLine: rb.deliveryLine, undoLine: rb.undoLine, spoken: rb.spoken, blockedReason });
          return blockedReason
            ? { status: "blocked", reason: blockedReason, note: "Tell the person the reason. Do not ask them to confirm." }
            : { status: "read_back_shown", total: money(cart.totals!.totalCents), note: "The app is reading the order and showing Confirm. Do not say it is ordered. Say one short sentence and wait." };
        }),
    }),

    cancel_order: tool({
      description: "Cancel an order during its undo window. With no id, cancels the most recent order that hasn't been charged.",
      inputSchema: z.object({ order_id: id.optional() }),
      execute: ({ order_id }) =>
        friendly(async () => {
          const target = order_id ?? (await latestHeldOrder(ctx.userId))?.id;
          if (!target) return { error: "There's no order that can still be cancelled. If it was already charged, I can start a return." };
          const r = await cancelOrder(ctx.userId, target);
          ctx.orderFacts.seen = true;
          ctx.events.push({ type: "order_cancelled", orderId: r.order.id });
          return { cancelled: true, status: r.order.status, message: r.message };
        }),
    }),

    order_status: tool({
      description: "The person's recent orders: status, amount, tracking and arrival.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(10).default(3) }),
      execute: async ({ limit }) => {
        const rows = await listOrders(ctx.userId, limit);
        ctx.orderFacts.seen = rows.length > 0;
        const words = { held: "placed, money held, can still be cancelled", voided: "cancelled, nothing charged", captured: "paid", refunded: "refunded", failed: "failed, nothing charged" } as const;
        return {
          orders: rows.map((o) => ({
            order_id: o.id,
            store: o.storeName,
            items: o.items.map((i) => i.title),
            amount: money(o.amountCents, o.currency),
            status: words[o.status],
            cancel_until: o.status === "held" && o.undoUntil ? o.undoUntil.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : undefined,
            tracking: o.tracking ? `${o.tracking.status} with ${o.tracking.carrier}, arriving ${o.tracking.eta}` : o.status === "captured" ? "Not shipped yet" : undefined,
          })),
        };
      },
    }),

    spending_summary: tool({
      description: "How much the person has spent this month, by store, and how much of their monthly limit is left.",
      inputSchema: z.object({}),
      execute: async () => {
        const s = await spendingSummary(ctx.userId);
        const [rules] = await getDb().select().from(spendingRules).where(eq(spendingRules.userId, ctx.userId)).limit(1);
        return {
          this_month: money(s.totalCents),
          by_store: s.byStore.map((b) => ({ store: b.store, spent: money(b.total), orders: b.count })),
          monthly_limit: rules ? money(rules.monthlyCents) : "not set",
          left_this_month: rules ? money(Math.max(0, rules.monthlyCents - s.totalCents)) : "not set",
          per_order_limit: rules ? money(rules.perOrderCents) : "not set",
        };
      },
    }),

    start_return: tool({
      description: "Start a return for a paid order. The store refunds to PayPal. Ask the reason first.",
      inputSchema: z.object({ order_id: id, reason: z.string().min(2).max(200) }),
      execute: ({ order_id, reason }) =>
        friendly(async () => {
          const r = await startReturn(ctx.userId, order_id, reason);
          ctx.orderFacts.seen = true;
          return { started: true, message: r.message };
        }),
    }),
  };
}

export type AgentTools = ReturnType<typeof createTools>;

