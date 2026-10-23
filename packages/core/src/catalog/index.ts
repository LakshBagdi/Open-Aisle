/**
 * Finding products in our stores.
 *
 * Search is deliberately simple and explainable: score each product by how
 * many of the person's words appear in its title, brand, category and facts,
 * then apply hard filters (price, size, colour, in stock). The agent shows at
 * most three results, because that's what blind shoppers told researchers
 * they can hold in mind when listening.
 */
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { products, stores, type Product, type Store } from "../db/schema";

export * from "./channel3";

export type SearchInput = {
  query: string;
  maxPriceCents?: number;
  category?: string;
  size?: string;
  color?: string;
  storeIds?: string[];
  limit?: number;
};

export type SearchHit = {
  product: Product;
  store: Store;
  score: number;
  matchedOn: string[];
};

const STOP = new Set(["a", "an", "the", "for", "and", "or", "of", "to", "in", "with", "i", "need", "want", "some", "me", "my", "pair", "please", "under", "below", "size"]);

export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

function haystack(p: Product, s: Store) {
  return {
    title: p.title.toLowerCase(),
    brand: (p.brand ?? "").toLowerCase(),
    category: p.category.toLowerCase(),
    facts: Object.entries(p.attributes)
      .map(([k, v]) => `${k} ${v}`)
      .join(" ")
      .toLowerCase(),
    options: Object.values(p.options).flat().join(" ").toLowerCase(),
    store: s.name.toLowerCase(),
  };
}

function optionHas(p: Product, name: string, value: string) {
  const entry = Object.entries(p.options).find(([k]) => k.toLowerCase() === name);
  if (!entry) return name === "color" ? Object.values(p.attributes).some((v) => v.toLowerCase().includes(value.toLowerCase())) : false;
  return entry[1].some((v) => v.toLowerCase() === value.toLowerCase());
}

export async function searchCatalog(input: SearchInput): Promise<SearchHit[]> {
  const db = getDb();
  const where = [eq(products.inStock, true)];
  if (input.category) where.push(eq(products.category, input.category.toLowerCase()));
  if (input.storeIds?.length) where.push(inArray(products.storeId, input.storeIds));
  const rows = await db.select({ product: products, store: stores }).from(products).innerJoin(stores, eq(stores.id, products.storeId)).where(and(...where));

  const words = tokens(input.query);
  const hits: SearchHit[] = [];
  for (const { product, store } of rows) {
    if (input.maxPriceCents && product.priceCents > input.maxPriceCents) continue;
    if (input.size && !optionHas(product, "size", input.size)) continue;
    if (input.color && !optionHas(product, "color", input.color)) continue;
    const h = haystack(product, store);
    let score = 0;
    const matchedOn: string[] = [];
    for (const w of words) {
      if (h.title.includes(w)) (score += 3), matchedOn.push(w);
      else if (h.category.includes(w) || h.brand.includes(w)) (score += 2), matchedOn.push(w);
      else if (h.facts.includes(w) || h.options.includes(w)) (score += 1), matchedOn.push(w);
    }
    if (words.length > 0 && score === 0) continue;
    hits.push({ product, store, score, matchedOn });
  }
  hits.sort((a, b) => b.score - a.score || a.product.priceCents - b.product.priceCents);
  return hits.slice(0, Math.min(input.limit ?? 3, 5));
}

export async function getProductWithStore(productId: string) {
  const [row] = await getDb()
    .select({ product: products, store: stores })
    .from(products)
    .innerJoin(stores, eq(stores.id, products.storeId))
    .where(eq(products.id, productId))
    .limit(1);
  return row;
}

export async function listStores() {
  return getDb().select().from(stores).orderBy(stores.name);
}
