/**
 * Open Aisle database schema.
 *
 * Three groups of tables:
 *   1. The person      – users, spending rules, saved PayPal, conversations
 *   2. Stores & orders – stores, products, carts, confirmation tokens, orders, refunds
 *   3. Audit trail     – barriers, webhook events, AI runs, eval runs
 *
 * Money is ALWAYS stored as integer cents (`*_cents`). 54.99 dollars = 5499.
 * Decimals in floating point round wrongly (0.1 + 0.2 !== 0.3), integers never do.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// Columns every table shares.
const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ─── Shared JSON shapes ────────────────────────────────────────────────────

export type Modes = {
  screenReader: boolean;
  voice: boolean;
  plainWords: boolean;
  largeText: boolean;
};

export type ProductImage = {
  url: string;
  /** Text description of the photo. Empty string = missing = a barrier. */
  alt: string;
};

export type CartItem = {
  productId: string;
  sku: string;
  title: string;
  variant: Record<string, string>; // e.g. { size: "9", color: "Black" }
  quantity: number;
  unitPriceCents: number;
};

export type CartTotals = {
  subtotalCents: number;
  taxCents: number;
  deliveryCents: number;
  totalCents: number;
  currency: string;
  deliveryEstimate: string; // e.g. "Thursday, Oct 23"
};

export type Tracking = {
  carrier: string;
  trackingNumber: string;
  status: string;
  eta?: string;
};

// ─── 1. The person ──────────────────────────────────────────────────────────

export const languageEnum = pgEnum("language", ["en", "hi"]);

export const users = pgTable("users", {
  id: id(),
  displayName: text("display_name").notNull(),
  email: text("email"),
  language: languageEnum("language").notNull().default("en"),
  modes: jsonb("modes")
    .$type<Modes>()
    .notNull()
    .default({ screenReader: true, voice: false, plainWords: false, largeText: false }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** The limits the agent must obey. `jws` is the signed copy; the server checks it. */
export const spendingRules = pgTable(
  "spending_rules",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    perOrderCents: integer("per_order_cents").notNull(),
    monthlyCents: integer("monthly_cents").notNull(),
    allowedStoreIds: jsonb("allowed_store_ids").$type<string[]>().notNull().default([]),
    undoWindowSeconds: integer("undo_window_seconds").notNull().default(600),
    version: integer("version").notNull().default(1),
    jws: text("jws").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("spending_rules_user_unique").on(t.userId)],
);

export const vaultStatusEnum = pgEnum("vault_status", ["pending", "active", "removed"]);

/** The person's saved PayPal account (PayPal vault). We only keep PayPal's IDs. */
export const paypalVault = pgTable("paypal_vault", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  setupTokenId: text("setup_token_id"),
  paypalCustomerId: text("paypal_customer_id"),
  paymentTokenId: text("payment_token_id"),
  payerEmail: text("payer_email"),
  status: vaultStatusEnum("status").notNull().default("pending"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const roleEnum = pgEnum("message_role", ["user", "assistant", "system"]);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull(),
    text: text("text").notNull(),
    toolCalls: jsonb("tool_calls").$type<unknown[]>().notNull().default([]),
    groundingCheck: jsonb("grounding_check").$type<{ passed: boolean; problems: string[] }>(),
    createdAt: createdAt(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt)],
);

// ─── 2. Stores, carts and orders ────────────────────────────────────────────

export const stores = pgTable("stores", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  paypalMerchantId: text("paypal_merchant_id"),
  returnPolicy: text("return_policy"),
  deliveryDays: integer("delivery_days").notNull().default(4),
  deliveryCents: integer("delivery_cents").notNull().default(0),
  freeDeliveryOverCents: integer("free_delivery_over_cents"),
  taxRateBasisPoints: integer("tax_rate_bps").notNull().default(0), // 825 = 8.25%
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const products = pgTable(
  "products",
  {
    id: id(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    sku: text("sku").notNull(),
    channel3Id: text("channel3_id"),
    category: text("category").notNull(),
    title: text("title").notNull(),
    brand: text("brand"),
    description: text("description").notNull().default(""),
    priceCents: integer("price_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    /** Structured facts: material, colour, fit, care... The agent may ONLY state these. */
    attributes: jsonb("attributes").$type<Record<string, string>>().notNull().default({}),
    /** Which choices a shopper must make, e.g. { size: ["8","9","10"], color: ["Black"] } */
    options: jsonb("options").$type<Record<string, string[]>>().notNull().default({}),
    images: jsonb("images").$type<ProductImage[]>().notNull().default([]),
    sizeChart: text("size_chart"),
    returnPolicy: text("return_policy"),
    inStock: boolean("in_stock").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_store_sku_unique").on(t.storeId, t.sku),
    index("products_category_idx").on(t.category),
  ],
);

export const cartStatusEnum = pgEnum("cart_status", ["open", "ordered", "abandoned"]);

export const carts = pgTable("carts", {
  id: id(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  items: jsonb("items").$type<CartItem[]>().notNull().default([]),
  totals: jsonb("totals").$type<CartTotals>(),
  status: cartStatusEnum("status").notNull().default("open"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Proof the person said yes to ONE exact cart.
 * We only store a hash of the token (like a password), plus a fingerprint
 * (`cartHash`) of the cart's exact contents and total at read-back time.
 */
export const confirmationTokens = pgTable("confirmation_tokens", {
  id: id(),
  tokenHash: text("token_hash").notNull().unique(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  cartId: uuid("cart_id")
    .notNull()
    .references(() => carts.id, { onDelete: "cascade" }),
  cartHash: text("cart_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const orderStatusEnum = pgEnum("order_status", [
  "held", // payment authorized, undo window open
  "voided", // person changed their mind, hold released
  "captured", // money taken
  "refunded",
  "failed",
]);

export const orders = pgTable(
  "orders",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id),
    cartId: uuid("cart_id")
      .notNull()
      .references(() => carts.id),
    items: jsonb("items").$type<CartItem[]>().notNull(),
    totals: jsonb("totals").$type<CartTotals>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    paypalOrderId: text("paypal_order_id").unique(),
    authorizationId: text("authorization_id").unique(),
    captureId: text("capture_id").unique(),
    status: orderStatusEnum("status").notNull().default("held"),
    undoUntil: timestamp("undo_until", { withTimezone: true }),
    tracking: jsonb("tracking").$type<Tracking>(),
    failureReason: text("failure_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_user_idx").on(t.userId, t.createdAt),
    // The worker scans this every few seconds: "held orders whose undo window has ended".
    index("orders_due_capture_idx").on(t.status, t.undoUntil),
  ],
);

export const refunds = pgTable("refunds", {
  id: id(),
  orderId: uuid("order_id")
    .notNull()
    .references(() => orders.id),
  paypalRefundId: text("paypal_refund_id").unique(),
  amountCents: integer("amount_cents").notNull(),
  reason: text("reason"),
  status: text("status").notNull().default("pending"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Plain-language updates for the person ("Northwind refunded $54.99"). */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    orderId: uuid("order_id").references(() => orders.id),
    text: text("text").notNull(),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/**
 * Keys a store's own systems use to call the Merchant API (/api/v1).
 * Like confirmation tokens, we keep only a hash. `prefix` is the first few
 * characters, so a merchant can tell their keys apart without us storing them.
 */
export const merchantApiKeys = pgTable(
  "merchant_api_keys",
  {
    id: id(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull().unique(),
    prefix: text("prefix").notNull(),
    label: text("label").notNull().default("default"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("merchant_api_keys_store_idx").on(t.storeId)],
);

// ─── 3. Audit trail ─────────────────────────────────────────────────────────

export const barrierKindEnum = pgEnum("barrier_kind", [
  "missing_alt_text",
  "missing_size_chart",
  "missing_return_policy",
  "missing_material",
  "unclear_color",
]);

// "in_progress" = the merchant has picked it up (shown as a column on the fix board).
export const barrierStatusEnum = pgEnum("barrier_status", ["open", "in_progress", "fixed", "dismissed"]);

/** Missing information the agent ran into. Merchants see these and fix them. */
export const barriers = pgTable(
  "barriers",
  {
    id: id(),
    storeId: uuid("store_id")
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    kind: barrierKindEnum("kind").notNull(),
    detail: text("detail").notNull().default(""),
    timesHit: integer("times_hit").notNull().default(0),
    suggestedFix: text("suggested_fix"),
    status: barrierStatusEnum("status").notNull().default("open"),
    lastHitAt: timestamp("last_hit_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("barriers_product_kind_unique").on(t.productId, t.kind)],
);

export const webhookEvents = pgTable("webhook_events", {
  id: id(),
  paypalEventId: text("paypal_event_id").notNull().unique(), // idempotency key
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  payload: jsonb("payload").notNull(),
  verified: boolean("verified").notNull().default(false),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  error: text("error"),
  createdAt: createdAt(),
});

export const aiRuns = pgTable("ai_runs", {
  id: id(),
  conversationId: uuid("conversation_id"),
  step: text("step").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  output: jsonb("output"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  durationMs: integer("duration_ms"),
  createdAt: createdAt(),
});

export const evalRuns = pgTable("eval_runs", {
  id: id(),
  promptVersion: text("prompt_version").notNull(),
  scores: jsonb("scores").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull().default(sql`now()`),
});

export type User = typeof users.$inferSelect;
export type Store = typeof stores.$inferSelect;
export type Product = typeof products.$inferSelect;
export type Cart = typeof carts.$inferSelect;
export type Order = typeof orders.$inferSelect;
export type Barrier = typeof barriers.$inferSelect;
export type SpendingRules = typeof spendingRules.$inferSelect;
export type MerchantApiKey = typeof merchantApiKeys.$inferSelect;
