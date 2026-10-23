/**
 * Replace a demo store's catalog with real products from Channel3.
 *
 *   CHANNEL3_API_KEY=... pnpm --filter @open-aisle/core tsx scripts/import-channel3.ts northwind "running shoes" "rain jacket"
 *
 * Keeps whatever photo descriptions Channel3 has; missing ones become
 * barriers the merchant can fix. Check Channel3's terms before using their
 * images in a public demo.
 */
import "dotenv/config";
import { eq } from "drizzle-orm";
import { scanStoreBarriers } from "../src/barriers";
import { channel3Available, factsFromChannel3, searchChannel3 } from "../src/catalog";
import { closeDb, getDb } from "../src/db";
import { products, stores } from "../src/db/schema";

const CATEGORY_HINTS: [RegExp, string][] = [
  [/shoe|sneaker|boot|runner/i, "shoes"],
  [/shirt|jacket|fleece|sock|hoodie|pant/i, "clothing"],
  [/mug|pan|knife|scale|kitchen|cup/i, "kitchen"],
];

async function main() {
  const [slug, ...queries] = process.argv.slice(2);
  if (!slug || queries.length === 0) throw new Error('Usage: import-channel3.ts <store-slug> "query one" "query two"');
  if (!channel3Available()) throw new Error("Set CHANNEL3_API_KEY first.");

  const db = getDb();
  const [store] = await db.select().from(stores).where(eq(stores.slug, slug)).limit(1);
  if (!store) throw new Error(`No store with slug ${slug}. Run pnpm db:seed first.`);
  await db.delete(products).where(eq(products.storeId, store.id));

  let count = 0;
  for (const q of queries) {
    const results = await searchChannel3(q, { limit: 8 });
    const category = CATEGORY_HINTS.find(([re]) => re.test(q))?.[1] ?? "home";
    for (const p of results) {
      const f = factsFromChannel3(p);
      if (!f.priceCents) continue;
      await db
        .insert(products)
        .values({
          storeId: store.id,
          sku: `C3-${p.id}`.slice(0, 64),
          channel3Id: f.channel3Id,
          category,
          title: f.title,
          brand: f.brand,
          description: f.description.slice(0, 2000),
          priceCents: f.priceCents,
          attributes: f.attributes,
          options: f.options,
          images: f.images,
        })
        .onConflictDoNothing();
      count++;
    }
  }
  const n = await scanStoreBarriers(store.id);
  console.log(`Imported ${count} products into ${store.name}; ${n} barriers found.`);
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exitCode = 1;
  })
  .finally(closeDb);
