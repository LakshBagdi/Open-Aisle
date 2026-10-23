/**
 * The grounding check: before a reply is spoken, every price and measurement
 * in it must appear in a tool result from this conversation.
 *
 * Analogy: a fact-checker who only has the store's own data sheet. Any number
 * in the script that isn't on the sheet gets crossed out.
 */

export type GroundingResult = { passed: boolean; problems: string[] };

const MONEY = /(?:\$|US\$|₹|rs\.?\s?)\s?\d[\d,]*(?:\.\d{1,2})?|\d[\d,]*(?:\.\d{1,2})?\s?(?:dollars|usd|rupees)/gi;
const MEASURE = /\b\d+(?:\.\d+)?\s?(?:cm|mm|kg|g|ml|l|°c|inch(?:es)?|oz|lbs?)\b/gi;
const PAID_CLAIM = /\b(?:i(?:'ve| have)?\s+(?:paid|placed (?:the|your) order|charged|bought|purchased|ordered))\b|\b(?:your order (?:is|has been) (?:placed|paid|confirmed))\b/i;

function normalizeMoney(s: string): string[] {
  const digits = s.replace(/[^\d.]/g, "");
  const n = Number(digits.replace(/,/g, ""));
  if (!Number.isFinite(n)) return [s.toLowerCase()];
  // "$54.99", "54.99", "$55" and "$55.00" are the same claim.
  return [n.toFixed(2), Number.isInteger(n) ? String(n) : n.toFixed(2)];
}

function normalizeMeasure(s: string): string {
  return s.toLowerCase().replace(/\s+/g, "");
}

/**
 * @param reply   what the agent wants to say
 * @param facts   JSON text of every tool result the agent has seen
 * @param orderFactsThisTurn  whether a tool result this turn reported an order status
 */
export function checkGrounding(reply: string, facts: string, orderFactsThisTurn: boolean): GroundingResult {
  const problems: string[] = [];
  const factText = facts.toLowerCase();
  const factCompact = factText.replace(/\s+/g, "");
  const factNumbers = new Set<string>();
  for (const m of factText.match(/\d[\d,]*(?:\.\d{1,2})?/g) ?? []) {
    const n = Number(m.replace(/,/g, ""));
    if (Number.isFinite(n)) {
      factNumbers.add(n.toFixed(2));
      if (Number.isInteger(n)) factNumbers.add(String(n));
    }
  }
  // Our tools give cents too ("price_cents": 5499): treat those as dollars as well.
  for (const m of factText.match(/_cents"?\s*:\s*(\d+)/g) ?? []) {
    const n = Number(m.replace(/\D/g, "")) / 100;
    factNumbers.add(n.toFixed(2));
  }

  for (const m of reply.match(MONEY) ?? []) {
    if (!normalizeMoney(m).some((v) => factNumbers.has(v))) problems.push(`Price "${m.trim()}" is not in any tool result`);
  }
  for (const m of reply.match(MEASURE) ?? []) {
    if (!factCompact.includes(normalizeMeasure(m))) problems.push(`Measurement "${m.trim()}" is not in any tool result`);
  }
  if (PAID_CLAIM.test(reply) && !orderFactsThisTurn) problems.push("Claims an order was placed or paid, but no tool result says so");
  return { passed: problems.length === 0, problems };
}

/** Last resort: remove sentences that still fail after a retry. */
export function removeUngroundedSentences(reply: string, problems: string[], lang: "en" | "hi"): string {
  const bad = problems.map((p) => p.match(/"([^"]+)"/)?.[1]).filter((x): x is string => Boolean(x));
  const sentences = reply.split(/(?<=[.!?।])\s+/);
  const kept = sentences.filter((s) => !bad.some((b) => s.includes(b)) && !PAID_CLAIM.test(s));
  const note = lang === "hi" ? "कुछ जानकारी मैं पक्की नहीं कर पाया, इसलिए मैंने उसे छोड़ दिया।" : "I left out something I couldn't confirm from the store's data.";
  return [...kept, note].join(" ");
}

/** Screen readers read "*" as "star". Strip markdown the model might still produce. */
export function toSpeakable(text: string): string {
  return text
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
