/**
 * Who is shopping.
 *
 * Local development and tests: one demo shopper (Asha), created by `pnpm db:seed`.
 * Hosted demo (DEMO_SESSIONS=per-visitor): each browser gets its own shopper,
 * via a cookie set in proxy.ts, so visitors don't share carts, orders or limits.
 * Real sign-in is out of scope; this is the one place to add it later.
 */
import "server-only";
import { cookies } from "next/headers";
import { ensureShopper } from "@open-aisle/core/account";

export const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "00000000-0000-4000-8000-00000000a5a0";
export const SHOPPER_COOKIE = "oa_shopper";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function currentUserId(): Promise<string> {
  if (process.env.DEMO_SESSIONS !== "per-visitor") return DEMO_USER_ID;
  const id = (await cookies()).get(SHOPPER_COOKIE)?.value;
  if (!id || !UUID.test(id)) return DEMO_USER_ID;
  await ensureShopper(id);
  return id;
}
