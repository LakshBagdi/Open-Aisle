/**
 * Channel3: a catalog of real products with clean structured data.
 *
 * Open Aisle uses it two ways:
 *  1. Seeding the demo stores with real products (scripts/import-channel3.ts).
 *  2. Live, during a conversation: "is this a fair price?" compares our
 *     store's price with the same kind of product across the web.
 *
 * Structured data is what makes honest answers possible: the agent can only
 * say "the upper is mesh" if a field says so.
 */
import { Channel3, type Channel3Api } from "@channel3/sdk";
import { env } from "../env";

let client: Channel3 | undefined;

export function channel3Available() {
  return Boolean(env().CHANNEL3_API_KEY);
}

function c3(): Channel3 {
  if (!client) client = new Channel3({ apiKey: env().CHANNEL3_API_KEY });
  return client;
}

export type Channel3Product = Channel3Api.Product;

export async function searchChannel3(query: string, opts: { limit?: number; maxPriceDollars?: number } = {}) {
  const page = await c3().products.search({
    query,
    limit: opts.limit ?? 10,
    filters: opts.maxPriceDollars ? { price: { max_price: opts.maxPriceDollars } } : undefined,
  });
  return page.data;
}

/** What similar products cost elsewhere, so the person can judge the price. */
export async function priceComparison(query: string, ourPriceCents: number) {
  const results = await searchChannel3(query, { limit: 10 });
  const prices = results
    .map((p) => p.offers?.[0]?.price)
    .filter((p): p is Channel3Api.Price => Boolean(p) && p!.currency === "USD")
    .map((p) => Math.round(p.price * 100))
    .sort((a, b) => a - b);
  if (prices.length < 3) return { enough: false as const, compared: prices.length };
  const median = prices[Math.floor(prices.length / 2)]!;
  return {
    enough: true as const,
    compared: prices.length,
    lowCents: prices[0]!,
    medianCents: median,
    highCents: prices[prices.length - 1]!,
    verdict: ourPriceCents <= median * 0.9 ? "below_typical" : ourPriceCents >= median * 1.15 ? "above_typical" : "typical",
  };
}

/** Turn a Channel3 product into the facts our store keeps. */
export function factsFromChannel3(p: Channel3Product) {
  const attributes: Record<string, string> = {};
  if (p.materials?.length) attributes.material = p.materials.join(", ");
  if (p.gender) attributes.gender = String(p.gender);
  for (const [k, v] of Object.entries(p.structured_attributes ?? {}) as [string, string[] | undefined][]) {
    if (v?.length) attributes[k.replace(/_/g, " ")] = v.join(", ");
  }
  if (p.key_features?.length) attributes["key features"] = p.key_features.slice(0, 5).join("; ");

  const options: Record<string, string[]> = {};
  for (const o of p.variants?.options ?? []) {
    const values = o.values.filter((v) => v.exists).map((v) => v.label);
    if (values.length) options[o.name.toLowerCase()] = values;
  }
  return {
    channel3Id: p.id,
    title: p.title,
    brand: p.brands?.[0]?.name ?? null,
    description: p.description ?? "",
    priceCents: p.offers?.[0] ? Math.round(p.offers[0].price.price * 100) : null,
    attributes,
    options,
    images: (p.images ?? []).slice(0, 3).map((i) => ({ url: i.url, alt: i.alt_text ?? "" })),
  };
}
