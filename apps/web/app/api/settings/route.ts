/**
 * GET  /api/settings — modes, language, PayPal status, spending limits.
 * POST /api/settings — save them. New limits are signed again.
 */
import { getAccountStatus, getUser, updateSettings } from "@open-aisle/core/account";
import { listStores } from "@open-aisle/core/catalog";
import { setSpendingRules } from "@open-aisle/core/rules";
import { z } from "zod";
import { fail, handleError, ok, sameOrigin } from "@/lib/http";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function GET() {
  try {
    const userId = await currentUserId();
    const [user, status, stores] = await Promise.all([getUser(userId), getAccountStatus(userId), listStores()]);
    if (!user) return fail("No demo shopper yet. Run pnpm db:seed.", 404);
    return ok({ user: { displayName: user.displayName, language: user.language, modes: user.modes }, ...status, stores: stores.map((s) => ({ id: s.id, name: s.name })) });
  } catch (err) {
    return handleError(err);
  }
}

const Body = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  language: z.enum(["en", "hi"]).optional(),
  modes: z.object({ screenReader: z.boolean(), voice: z.boolean(), plainWords: z.boolean(), largeText: z.boolean() }).partial().optional(),
  limits: z
    .object({
      perOrderDollars: z.number().positive().max(10_000),
      monthlyDollars: z.number().positive().max(50_000),
      undoMinutes: z.number().int().min(1).max(60),
      allowedStoreIds: z.array(z.string().uuid()),
    })
    .optional(),
});

export async function POST(req: Request) {
  if (!sameOrigin(req)) return fail("Request blocked.", 403);
  try {
    const body = Body.parse(await req.json());
    const userId = await currentUserId();
    await updateSettings(userId, body);
    if (body.limits) {
      await setSpendingRules(userId, {
        perOrderCents: Math.round(body.limits.perOrderDollars * 100),
        monthlyCents: Math.round(body.limits.monthlyDollars * 100),
        undoWindowSeconds: body.limits.undoMinutes * 60,
        allowedStoreIds: body.limits.allowedStoreIds,
      });
    }
    return ok({ message: "Settings saved." });
  } catch (err) {
    if (err instanceof Error && /limit|window/i.test(err.message) && err.name === "Error") return fail(err.message, 400);
    return handleError(err);
  }
}
