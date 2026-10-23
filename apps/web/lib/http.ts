/**
 * Small helpers so every API route answers the same way:
 * success → { ok: true, ...data }, failure → { ok: false, error: "plain sentence" }.
 * The error sentence is what the person hears, so it must be human.
 */
import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function ok<T extends object>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, ...data }, init);
}

export function fail(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status });
}

/** Known errors carry a person-friendly message; anything else is logged and hidden. */
export function handleError(err: unknown) {
  if (err instanceof ZodError) return fail("Some of the details sent were not valid.", 400);
  const name = err instanceof Error ? err.name : "";
  if (["CartError", "OrderError", "ConfirmationError"].includes(name)) return fail((err as Error).message, 409);
  if (name === "AgentUnavailableError") return fail((err as Error).message, 503);
  console.error(err);
  return fail("Something went wrong on our side. Nothing was charged. Please try again.", 500);
}

/** Basic protection: state-changing requests must come from our own pages. */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true; // non-browser clients (tests, curl)
  try {
    return new URL(origin).host === req.headers.get("host");
  } catch {
    return false;
  }
}
