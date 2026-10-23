/**
 * GET /img/product/<sku>.svg — a simple drawn picture for each demo product,
 * so the demo has no copyrighted product photos. Real stores use real photos.
 */
import { getDb } from "@open-aisle/core";
import { products } from "@open-aisle/core/db/schema";
import { eq } from "drizzle-orm";

export const runtime = "nodejs";

const COLORS: Record<string, string> = {
  black: "#1f2933",
  navy: "#1d3a6b",
  blue: "#2f6fb5",
  grey: "#8a96a3",
  gray: "#8a96a3",
  brown: "#7a4b2a",
  yellow: "#f2c230",
  green: "#2f7d4f",
  white: "#f4f6f8",
  cream: "#efe6d2",
};

function colorOf(attrs: Record<string, string>) {
  const c = (attrs.color ?? "").toLowerCase();
  return Object.entries(COLORS).find(([k]) => c.includes(k))?.[1] ?? "#6b7f99";
}

const SHAPES: Record<string, (c: string) => string> = {
  shoes: (c) => `<path d="M60 250 Q70 170 140 160 L200 150 Q230 190 300 200 Q360 210 370 250 Z" fill="${c}"/><rect x="55" y="250" width="320" height="22" rx="10" fill="#f4f6f8" stroke="#c9d1da"/>`,
  clothing: (c) => `<path d="M140 90 L200 110 L260 90 L330 140 L300 190 L270 170 L270 300 L130 300 L130 170 L100 190 L70 140 Z" fill="${c}"/>`,
  kitchen: (c) => `<rect x="120" y="120" width="150" height="170" rx="18" fill="${c}"/><path d="M270 160 q60 0 60 50 q0 50 -60 50" fill="none" stroke="${c}" stroke-width="22"/>`,
  home: (c) => `<rect x="90" y="130" width="240" height="150" rx="16" fill="${c}"/><rect x="110" y="150" width="200" height="110" rx="8" fill="none" stroke="#ffffff" stroke-opacity=".35" stroke-width="4"/>`,
};

export async function GET(_req: Request, ctx: { params: Promise<{ file: string }> }) {
  const { file } = await ctx.params;
  const sku = file.replace(/\.svg$/, "");
  const [p] = await getDb().select().from(products).where(eq(products.sku, sku)).limit(1);
  const shape = (SHAPES[p?.category ?? "home"] ?? SHAPES.home!)(colorOf(p?.attributes ?? {}));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 360" role="img"><rect width="420" height="360" fill="#eef2f7"/>${shape}</svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
}
