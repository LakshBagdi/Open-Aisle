/**
 * Hosted demo only (DEMO_SESSIONS=per-visitor): give each new browser its own
 * shopper id in a cookie. The id is also added to THIS request, so the very
 * first page already uses it.
 */
import { NextResponse, type NextRequest } from "next/server";

const COOKIE = "oa_shopper";

export function proxy(req: NextRequest) {
  if (process.env.DEMO_SESSIONS !== "per-visitor" || req.cookies.has(COOKIE)) return NextResponse.next();
  const id = crypto.randomUUID();
  const headers = new Headers(req.headers);
  const existing = req.headers.get("cookie");
  headers.set("cookie", existing ? `${existing}; ${COOKIE}=${id}` : `${COOKIE}=${id}`);
  const res = NextResponse.next({ request: { headers } });
  res.cookies.set(COOKIE, id, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", maxAge: 60 * 60 * 24 * 30, path: "/" });
  return res;
}

export const config = {
  // Shopper pages and their API routes; not static files, webhooks or the Merchant API.
  matcher: ["/((?!_next/|img/|favicon|openapi.yaml|api/v1/|api/paypal/webhook).*)"],
};
