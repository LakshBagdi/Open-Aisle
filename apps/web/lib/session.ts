/**
 * Who is shopping.
 *
 * Hackathon scope: one demo shopper (Asha), created by `pnpm db:seed`.
 * Real sign-in is out of scope; this is the one place to add it later.
 */
import "server-only";

export const DEMO_USER_ID = process.env.DEMO_USER_ID ?? "00000000-0000-4000-8000-00000000a5a0";

export async function currentUserId(): Promise<string> {
  return DEMO_USER_ID;
}
