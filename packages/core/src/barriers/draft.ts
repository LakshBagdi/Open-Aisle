/**
 * Drafting a fix for a barrier, so a busy merchant only has to check and accept.
 *
 * Honesty rule: the AI may describe what it can see in a photo, or rephrase
 * facts the store already gave. It must never invent measurements, materials
 * or policies. For those it drafts a fill-in template instead.
 */
import { generateText, type LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import { barriers, products, stores } from "../db/schema";

export type Draft = { text: string; source: "ai_from_photo" | "ai_from_facts" | "template"; note: string };

const TEMPLATES = {
  missing_size_chart: (sizes: string) => `Sizes by foot length: ${sizes.split(", ").map((s) => `${s} = __ cm`).join(", ")}.`,
  missing_return_policy: () => "Returns accepted within __ days if unused. Refunds go back to your PayPal within __ days of us receiving the item.",
  missing_material: () => "Upper: __. Lining: __. Sole: __.",
};

export async function draftFix(barrierId: string, model?: LanguageModel): Promise<Draft> {
  const db = getDb();
  const [b] = await db.select().from(barriers).where(eq(barriers.id, barrierId)).limit(1);
  if (!b?.productId) throw new Error("Barrier not found.");
  const [p] = await db.select().from(products).where(eq(products.id, b.productId)).limit(1);
  const [s] = await db.select().from(stores).where(eq(stores.id, b.storeId)).limit(1);
  if (!p || !s) throw new Error("Product not found.");

  const facts = Object.entries(p.attributes)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");

  let draft: Draft;
  switch (b.kind) {
    case "missing_size_chart":
      draft = { text: TEMPLATES.missing_size_chart(Object.entries(p.options).find(([k]) => k.toLowerCase() === "size")?.[1].join(", ") ?? "S, M, L"), source: "template", note: "Fill in the real measurements. Open Aisle never guesses sizes." };
      break;
    case "missing_return_policy":
      draft = { text: TEMPLATES.missing_return_policy(), source: "template", note: "Fill in your real policy." };
      break;
    case "missing_material":
      draft = { text: TEMPLATES.missing_material(), source: "template", note: "Only you know what it's made of." };
      break;
    case "missing_alt_text":
    case "unclear_color": {
      const img = p.images[0];
      if (model && img && /^https?:\/\//.test(img.url)) {
        const res = await generateText({
          model,
          maxOutputTokens: 160,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `Write alt text for this product photo, for blind shoppers: one or two sentences, start with what it is, then colours, shape and any visible details. No marketing words. Product: "${p.title}".` },
                { type: "file", mediaType: "image", data: img.url },
              ],
            },
          ],
        });
        draft = { text: res.text.trim(), source: "ai_from_photo", note: "Written by AI from the photo. Check it matches the photo before accepting." };
      } else if (model) {
        const res = await generateText({
          model,
          maxOutputTokens: 120,
          prompt: `Write a one-sentence photo description for blind shoppers for "${p.title}", using ONLY these facts: ${facts || "none"}. If the facts don't say the colour or shape, don't mention them. No marketing words.`,
        });
        draft = { text: res.text.trim(), source: "ai_from_facts", note: "Written by AI from your product facts, not the photo. Check it matches the photo." };
      } else {
        draft = { text: `${p.title}${p.attributes.color ? `, ${p.attributes.color}` : ""}.`, source: "template", note: "AI drafting is off. Describe what the photo shows." };
      }
      break;
    }
  }
  await db.update(barriers).set({ suggestedFix: draft.text }).where(eq(barriers.id, b.id));
  return draft;
}
