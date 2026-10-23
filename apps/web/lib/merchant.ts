/**
 * Shared plumbing for the Merchant API (/api/v1/...).
 *
 * Every route: read the API key → find the store → run one core function →
 * answer as JSON. Errors use the same shape everywhere:
 *   { ok: false, error: "plain sentence", code: "not_found" }
 * so the APIMatic-generated SDKs can turn them into typed exceptions.
 */
import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { authenticateApiKey, MerchantError } from "@open-aisle/core/merchant";
import type { Store } from "@open-aisle/core/db/schema";

const STATUS: Record<MerchantError["code"], number> = { unauthorized: 401, not_found: 404, conflict: 409, invalid: 422 };

export function apiError(error: string, code: string, status: number) {
  return NextResponse.json({ ok: false, error, code }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function withStore(req: Request, fn: (store: Store) => Promise<unknown>) {
  try {
    const store = await authenticateApiKey(req.headers.get("authorization"));
    const data = await fn(store);
    return NextResponse.json({ ok: true, ...(data as object) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof MerchantError) return apiError(err.message, err.code, STATUS[err.code]);
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return apiError(`Invalid request: ${first ? `${first.path.join(".") || "body"} ${first.message}` : "check the fields"}.`, "invalid", 422);
    }
    if (err instanceof SyntaxError) return apiError("The request body must be JSON.", "invalid", 422);
    if (err instanceof Error && err.name === "PayPalError") return apiError(`PayPal said no: ${err.message}`, "paypal_error", 502);
    console.error(err);
    return apiError("Something went wrong on our side.", "server_error", 500);
  }
}

/** Read a JSON body; an empty body counts as {}. */
export async function jsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  return text.trim() ? JSON.parse(text) : {};
}
