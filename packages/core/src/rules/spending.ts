/**
 * Spending rules: the limits the agent must obey, checked by plain code.
 * The AI never sees these checks and cannot talk its way past them.
 */
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { getDb } from "../db";
import { orders, spendingRules, type SpendingRules } from "../db/schema";
import { formatMoney } from "../money";
import { signRules, verifyRules, type RulesPayload } from "./signing";

export type RulesInput = {
  perOrderCents: number;
  monthlyCents: number;
  allowedStoreIds: string[];
  undoWindowSeconds?: number;
};

/** Create or replace a person's rules, signed. */
export async function setSpendingRules(userId: string, input: RulesInput): Promise<SpendingRules> {
  if (input.perOrderCents <= 0 || input.monthlyCents <= 0) throw new Error("Spending limits need to be more than $0.");
  if (input.perOrderCents > input.monthlyCents) throw new Error("The most for one order can't be more than the most for a month. Lower the first, or raise the second.");
  const undo = input.undoWindowSeconds ?? 600;
  if (undo < 60 || undo > 3 * 24 * 3600) throw new Error("The time to change your mind must be between 1 minute and 3 days.");

  const db = getDb();
  const [existing] = await db.select().from(spendingRules).where(eq(spendingRules.userId, userId)).limit(1);
  const version = (existing?.version ?? 0) + 1;
  const payload: RulesPayload = {
    userId,
    perOrderCents: input.perOrderCents,
    monthlyCents: input.monthlyCents,
    allowedStoreIds: [...input.allowedStoreIds].sort(),
    undoWindowSeconds: undo,
    version,
  };
  const jws = await signRules(payload);
  const values = { ...payload, jws };
  const [row] = existing
    ? await db.update(spendingRules).set(values).where(eq(spendingRules.id, existing.id)).returning()
    : await db.insert(spendingRules).values(values).returning();
  return row!;
}

export type RulesCheck = { ok: true; rules: RulesPayload } | { ok: false; reason: string };

/** Everything we need to know before money moves. */
export async function checkSpending(userId: string, storeId: string, totalCents: number, currency: string, now = new Date()): Promise<RulesCheck> {
  const db = getDb();
  const [row] = await db.select().from(spendingRules).where(eq(spendingRules.userId, userId)).limit(1);
  if (!row) return { ok: false, reason: "You haven't set spending limits yet. Please set them in Settings first." };

  let signed: RulesPayload;
  try {
    signed = await verifyRules(row.jws);
  } catch {
    return { ok: false, reason: "Your spending limits couldn't be verified, so I won't pay. Please set them again in Settings." };
  }
  // The numbers in the table must be exactly the numbers that were signed.
  const same =
    signed.userId === userId &&
    signed.perOrderCents === row.perOrderCents &&
    signed.monthlyCents === row.monthlyCents &&
    signed.version === row.version &&
    JSON.stringify(signed.allowedStoreIds) === JSON.stringify([...row.allowedStoreIds].sort());
  if (!same) return { ok: false, reason: "Your spending limits were changed without being re-confirmed, so I won't pay." };

  if (signed.allowedStoreIds.length > 0 && !signed.allowedStoreIds.includes(storeId)) {
    return { ok: false, reason: "This store isn't on your list of allowed stores. You can change that in Settings." };
  }
  if (totalCents > signed.perOrderCents) {
    return { ok: false, reason: `This order is ${formatMoney(totalCents, currency)}, which is over your limit of ${formatMoney(signed.perOrderCents, currency)} per order. Take something out of your cart, or raise the limit in Settings.` };
  }
  const spent = await spentThisMonth(userId, now);
  if (spent + totalCents > signed.monthlyCents) {
    const left = Math.max(0, signed.monthlyCents - spent);
    return { ok: false, reason: `This order would go over your monthly limit. You have ${formatMoney(left, currency)} left this month. You can change the limit in Settings.` };
  }
  return { ok: true, rules: signed };
}

/** Held + captured orders this calendar month count towards the limit. */
export async function spentThisMonth(userId: string, now = new Date()): Promise<number> {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [r] = await getDb()
    .select({ total: sql<number>`coalesce(sum(${orders.amountCents}), 0)::int` })
    .from(orders)
    .where(and(eq(orders.userId, userId), inArray(orders.status, ["held", "captured"]), gte(orders.createdAt, start)));
  return r?.total ?? 0;
}
