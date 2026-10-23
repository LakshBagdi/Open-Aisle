/**
 * The cart, in the same shape as PayPal's agentic-commerce cart operations:
 * create a cart, add / remove items, get totals with tax and delivery.
 *
 * Every number here is computed by code from the store's own data.
 * The AI asks for changes; it never sets a price.
 */
import { and, eq } from "drizzle-orm";
import { getDb } from "../db";
import { carts, products, stores, type Cart, type CartItem, type CartTotals, type Product, type Store } from "../db/schema";

export class CartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartError";
  }
}

export function deliveryDate(days: number, from = new Date(), locale = "en-US"): string {
  // Count business days so "4 days" never lands on a Sunday.
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
}

export function computeTotals(store: Store, items: CartItem[], now = new Date()): CartTotals {
  const subtotalCents = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
  const taxCents = Math.round((subtotalCents * store.taxRateBasisPoints) / 10_000);
  const free = store.freeDeliveryOverCents != null && subtotalCents >= store.freeDeliveryOverCents;
  const deliveryCents = items.length === 0 || free ? 0 : store.deliveryCents;
  return {
    subtotalCents,
    taxCents,
    deliveryCents,
    totalCents: subtotalCents + taxCents + deliveryCents,
    currency: "USD",
    deliveryEstimate: deliveryDate(store.deliveryDays, now),
  };
}

/** Check the chosen size/colour etc. are real options of the product. */
export function validateVariant(product: Product, variant: Record<string, string>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [name, values] of Object.entries(product.options)) {
    const chosen = Object.entries(variant).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
    if (chosen === undefined) throw new CartError(`Please choose a ${name}. Options: ${values.join(", ")}.`);
    const match = values.find((v) => v.toLowerCase() === String(chosen).toLowerCase());
    if (!match) throw new CartError(`${chosen} isn't available for ${name}. Options: ${values.join(", ")}.`);
    clean[name] = match;
  }
  return clean;
}

const sameLine = (a: CartItem, productId: string, variant: Record<string, string>) =>
  a.productId === productId && JSON.stringify(Object.entries(a.variant).sort()) === JSON.stringify(Object.entries(variant).sort());

async function loadStore(storeId: string) {
  const [store] = await getDb().select().from(stores).where(eq(stores.id, storeId)).limit(1);
  if (!store) throw new CartError("Store not found.");
  return store;
}

export async function getOpenCart(userId: string, storeId: string): Promise<Cart> {
  const db = getDb();
  const [cart] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.userId, userId), eq(carts.storeId, storeId), eq(carts.status, "open")))
    .limit(1);
  if (cart) return cart;
  const store = await loadStore(storeId);
  const [created] = await db.insert(carts).values({ userId, storeId, items: [], totals: computeTotals(store, []) }).returning();
  return created!;
}

export async function getCart(userId: string, cartId: string): Promise<Cart> {
  const [cart] = await getDb().select().from(carts).where(and(eq(carts.id, cartId), eq(carts.userId, userId))).limit(1);
  if (!cart) throw new CartError("Cart not found.");
  return cart;
}

/** The person's open carts that have something in them. */
export async function listOpenCarts(userId: string): Promise<Cart[]> {
  const rows = await getDb().select().from(carts).where(and(eq(carts.userId, userId), eq(carts.status, "open")));
  return rows.filter((c) => c.items.length > 0);
}

async function saveItems(cart: Cart, items: CartItem[]): Promise<Cart> {
  const store = await loadStore(cart.storeId);
  const [updated] = await getDb()
    .update(carts)
    .set({ items, totals: computeTotals(store, items) })
    .where(and(eq(carts.id, cart.id), eq(carts.status, "open")))
    .returning();
  if (!updated) throw new CartError("That cart has already been ordered.");
  return updated;
}

export async function addToCart(userId: string, productId: string, variant: Record<string, string>, quantity = 1): Promise<Cart> {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new CartError("Quantity must be between 1 and 10.");
  const [product] = await getDb().select().from(products).where(eq(products.id, productId)).limit(1);
  if (!product) throw new CartError("I couldn't find that product.");
  if (!product.inStock) throw new CartError(`${product.title} is out of stock.`);
  const clean = validateVariant(product, variant);

  const cart = await getOpenCart(userId, product.storeId);
  const items = [...cart.items];
  const existing = items.find((i) => sameLine(i, productId, clean));
  if (existing) existing.quantity = Math.min(10, existing.quantity + quantity);
  else items.push({ productId, sku: product.sku, title: product.title, variant: clean, quantity, unitPriceCents: product.priceCents });
  return saveItems(cart, items);
}

export async function removeFromCart(userId: string, cartId: string, productId: string, variant?: Record<string, string>): Promise<Cart> {
  const cart = await getCart(userId, cartId);
  const items = cart.items.filter((i) => !(i.productId === productId && (!variant || sameLine(i, productId, variant))));
  if (items.length === cart.items.length) throw new CartError("That item isn't in the cart.");
  return saveItems(cart, items);
}

export async function setQuantity(userId: string, cartId: string, productId: string, quantity: number): Promise<Cart> {
  if (quantity === 0) return removeFromCart(userId, cartId, productId);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw new CartError("Quantity must be between 1 and 10.");
  const cart = await getCart(userId, cartId);
  const items = cart.items.map((i) => (i.productId === productId ? { ...i, quantity } : i));
  return saveItems(cart, items);
}

export async function emptyCart(userId: string, cartId: string): Promise<Cart> {
  return saveItems(await getCart(userId, cartId), []);
}
