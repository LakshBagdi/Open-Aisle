/**
 * A small in-memory rate limit, so a public demo can't be used to run up
 * AI costs or hammer PayPal. Per server instance; good enough for a demo.
 */
import "server-only";

const hits = new Map<string, number[]>();

export function rateLimited(req: Request, bucket: string, perMinute: number): boolean {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (v.every((t) => now - t > 60_000)) hits.delete(k);
  return recent.length > perMinute;
}
