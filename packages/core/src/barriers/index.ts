/**
 * Barriers: information a disabled shopper needs that the store didn't give.
 *
 * Every time the agent looks at a product, code (not the AI) checks for
 * missing facts and adds one to that barrier's counter. Merchants see the
 * list sorted by how often shoppers hit each one, with an AI-drafted fix.
 * One person's shopping trip becomes a fix for everyone at that store.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { barriers, products, stores, type Barrier, type Product, type Store } from "../db/schema";

export { draftFix, type Draft } from "./draft";

export type BarrierKind = Barrier["kind"];

const SIZED = new Set(["shoes", "clothing"]);

export function detectBarriers(product: Product, store: Pick<Store, "returnPolicy">): { kind: BarrierKind; detail: string }[] {
  const found: { kind: BarrierKind; detail: string }[] = [];
  const noAlt = product.images.filter((i) => !i.alt.trim());
  if (product.images.length > 0 && noAlt.length > 0) {
    found.push({ kind: "missing_alt_text", detail: `${noAlt.length} of ${product.images.length} photos have no description` });
  }
  if (SIZED.has(product.category) && "size" in lowerKeys(product.options) && !product.sizeChart?.trim()) {
    found.push({ kind: "missing_size_chart", detail: "Sizes are listed but there is no size chart" });
  }
  if (!product.returnPolicy?.trim() && !store.returnPolicy?.trim()) {
    found.push({ kind: "missing_return_policy", detail: "No return policy for this product or store" });
  }
  if (SIZED.has(product.category) && !("material" in lowerKeys(product.attributes))) {
    found.push({ kind: "missing_material", detail: "Material is not listed" });
  }
  if ("color" in lowerKeys(product.options) === false && !("color" in lowerKeys(product.attributes)) && SIZED.has(product.category)) {
    found.push({ kind: "unclear_color", detail: "Colour is only visible in the photo" });
  }
  return found;
}

function lowerKeys(o: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(o).map((k) => [k.toLowerCase(), true]));
}

/** Called whenever the agent looks at a product. Returns what was missing. */
export async function recordBarrierHits(product: Product, store: Pick<Store, "returnPolicy">) {
  const found = detectBarriers(product, store);
  if (found.length === 0) return found;
  await getDb()
    .insert(barriers)
    .values(found.map((b) => ({ storeId: product.storeId, productId: product.id, kind: b.kind, detail: b.detail, timesHit: 1, lastHitAt: new Date() })))
    .onConflictDoUpdate({
      target: [barriers.productId, barriers.kind],
      set: { timesHit: sql`${barriers.timesHit} + 1`, lastHitAt: new Date(), detail: sql`excluded.detail` },
      setWhere: sql`${barriers.status} = 'open'`,
    });
  return found;
}

/** Make sure every product's barriers exist (count 0) so merchants see them before anyone hits them. */
export async function scanStoreBarriers(storeId: string) {
  const db = getDb();
  const [store] = await db.select().from(stores).where(eq(stores.id, storeId)).limit(1);
  if (!store) return 0;
  const list = await db.select().from(products).where(eq(products.storeId, storeId));
  let n = 0;
  for (const p of list) {
    const found = detectBarriers(p, store);
    if (found.length === 0) continue;
    n += found.length;
    await db
      .insert(barriers)
      .values(found.map((b) => ({ storeId, productId: p.id, kind: b.kind, detail: b.detail })))
      .onConflictDoNothing({ target: [barriers.productId, barriers.kind] });
  }
  return n;
}

export async function listBarriers(storeId: string) {
  return getDb()
    .select({
      id: barriers.id,
      kind: barriers.kind,
      detail: barriers.detail,
      timesHit: barriers.timesHit,
      status: barriers.status,
      suggestedFix: barriers.suggestedFix,
      lastHitAt: barriers.lastHitAt,
      productId: products.id,
      productTitle: products.title,
      sku: products.sku,
    })
    .from(barriers)
    .innerJoin(products, eq(products.id, barriers.productId))
    .where(eq(barriers.storeId, storeId))
    .orderBy(desc(barriers.timesHit), barriers.kind);
}

/**
 * The merchant accepts a fix. We write it into the catalog, so the very next
 * shopper hears it, and close the barrier.
 */
export async function applyBarrierFix(storeId: string, barrierId: string, fixText: string) {
  const text = fixText.trim();
  if (!text) throw new Error("The fix can't be empty.");
  const db = getDb();
  const [b] = await db.select().from(barriers).where(and(eq(barriers.id, barrierId), eq(barriers.storeId, storeId))).limit(1);
  if (!b?.productId) throw new Error("Barrier not found.");
  const [p] = await db.select().from(products).where(eq(products.id, b.productId)).limit(1);
  if (!p) throw new Error("Product not found.");

  switch (b.kind) {
    case "missing_alt_text":
      await db.update(products).set({ images: p.images.map((i) => (i.alt.trim() ? i : { ...i, alt: text })) }).where(eq(products.id, p.id));
      break;
    case "missing_size_chart":
      await db.update(products).set({ sizeChart: text }).where(eq(products.id, p.id));
      break;
    case "missing_return_policy":
      await db.update(products).set({ returnPolicy: text }).where(eq(products.id, p.id));
      break;
    case "missing_material":
      await db.update(products).set({ attributes: { ...p.attributes, material: text } }).where(eq(products.id, p.id));
      break;
    case "unclear_color":
      await db.update(products).set({ attributes: { ...p.attributes, color: text } }).where(eq(products.id, p.id));
      break;
  }
  await db.update(barriers).set({ status: "fixed", suggestedFix: text }).where(eq(barriers.id, b.id));
}
