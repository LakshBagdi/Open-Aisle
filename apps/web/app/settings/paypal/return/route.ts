/**
 * GET /settings/paypal/return?approval_token_id=...
 * PayPal sends the person back here after they approve. We finish saving the
 * account and return them to Settings with a message their screen reader reads.
 */
import { finishPayPalConnection } from "@open-aisle/core/account";
import { NextResponse } from "next/server";
import { currentUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const setupTokenId = url.searchParams.get("approval_token_id");
  const back = new URL("/settings", url.origin);
  if (!setupTokenId) {
    back.searchParams.set("paypal", "missing");
    return NextResponse.redirect(back, 303);
  }
  try {
    await finishPayPalConnection(await currentUserId(), setupTokenId);
    back.searchParams.set("paypal", "connected");
  } catch (err) {
    console.error(err);
    back.searchParams.set("paypal", "failed");
  }
  return NextResponse.redirect(back, 303);
}
