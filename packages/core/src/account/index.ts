/**
 * The person's account: settings, and connecting PayPal once.
 *
 * Connecting PayPal is the one step Open Aisle can't make fully accessible,
 * because the approval page belongs to PayPal. It happens once, and a trusted
 * helper can do it with the person. After that there are no popups: every
 * purchase is paid with the saved account, and only after a confirmed read-back.
 */
import { and, desc, eq } from "drizzle-orm";
import { getDb } from "../db";
import { paypalVault, spendingRules, users, type Modes } from "../db/schema";
import { env } from "../env";
import { createPaymentToken, createSetupToken } from "../paypal";
import { setSpendingRules } from "../rules";
import type { Lang } from "../i18n";

export async function getUser(userId: string) {
  const [u] = await getDb().select().from(users).where(eq(users.id, userId)).limit(1);
  return u;
}

export async function updateSettings(userId: string, patch: { language?: Lang; modes?: Partial<Modes>; displayName?: string }) {
  const user = await getUser(userId);
  if (!user) throw new Error("User not found");
  const [u] = await getDb()
    .update(users)
    .set({
      language: patch.language ?? user.language,
      displayName: patch.displayName?.trim() || user.displayName,
      modes: { ...user.modes, ...patch.modes },
    })
    .where(eq(users.id, userId))
    .returning();
  return u!;
}

export async function getAccountStatus(userId: string) {
  const db = getDb();
  const [vault] = await db.select().from(paypalVault).where(and(eq(paypalVault.userId, userId), eq(paypalVault.status, "active"))).limit(1);
  const [rules] = await db.select().from(spendingRules).where(eq(spendingRules.userId, userId)).limit(1);
  return {
    paypalConnected: Boolean(vault),
    payerEmail: vault?.payerEmail ?? null,
    rules: rules
      ? { perOrderCents: rules.perOrderCents, monthlyCents: rules.monthlyCents, allowedStoreIds: rules.allowedStoreIds, undoWindowSeconds: rules.undoWindowSeconds }
      : null,
  };
}

/** Step 1: get PayPal's approval link. */
export async function startPayPalConnection(userId: string, opts: { from?: "shop" | "settings" } = {}) {
  const base = env().APP_URL;
  const shop = opts.from === "shop";
  const { setupTokenId, approveUrl } = await createSetupToken({
    // Back to where the person started, so connecting from the Shop doesn't strand them in Settings.
    returnUrl: `${base}/settings/paypal/return${shop ? "?to=shop" : ""}`,
    cancelUrl: shop ? `${base}/?paypal=cancelled` : `${base}/settings?paypal=cancelled`,
    requestId: `setup-${userId}-${Date.now()}`,
  });
  await getDb().insert(paypalVault).values({ userId, setupTokenId, status: "pending" });
  return { approveUrl };
}

/** Step 2: PayPal sent the person back. Swap the approved setup token for a saved account. */
export async function finishPayPalConnection(userId: string, setupTokenId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(paypalVault)
    .where(and(eq(paypalVault.userId, userId), eq(paypalVault.setupTokenId, setupTokenId)))
    .orderBy(desc(paypalVault.createdAt))
    .limit(1);
  if (!row) throw new Error("That PayPal connection wasn't started here.");
  if (row.status === "active") return row;

  const token = await createPaymentToken(setupTokenId, `vault-${row.id}`);
  // Only one active saved account per person.
  await db.update(paypalVault).set({ status: "removed" }).where(and(eq(paypalVault.userId, userId), eq(paypalVault.status, "active")));
  const [saved] = await db
    .update(paypalVault)
    .set({ status: "active", paymentTokenId: token.paymentTokenId, paypalCustomerId: token.customerId, payerEmail: token.payerEmail })
    .where(eq(paypalVault.id, row.id))
    .returning();
  return saved!;
}

const ensured = new Set<string>();

/**
 * Hosted demo: every visitor gets their own shopper (a copy of the demo
 * persona "Asha", with the same limits), so judges trying it at the same time
 * don't share a cart, orders or a monthly limit. Safe to call on every request.
 */
export async function ensureShopper(userId: string, displayName = "Asha") {
  if (ensured.has(userId)) return;
  const db = getDb();
  // A new visitor starts neutral (not "screen reader"): the first-visit question sets how they want to use it.
  const modes = { screenReader: false, voice: false, plainWords: false, largeText: false };
  const inserted = await db.insert(users).values({ id: userId, displayName, modes }).onConflictDoNothing({ target: users.id }).returning({ id: users.id });
  if (inserted.length > 0) {
    await setSpendingRules(userId, { perOrderCents: 15_000, monthlyCents: 40_000, allowedStoreIds: [], undoWindowSeconds: 600 });
  }
  ensured.add(userId);
}
