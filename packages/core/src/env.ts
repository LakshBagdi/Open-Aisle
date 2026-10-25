/**
 * Every setting the app reads from the environment, checked in one place.
 * If something required is missing we fail loudly at start-up, not halfway
 * through someone's purchase.
 */
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().default("postgres://openaisle:openaisle@localhost:5432/openaisle"),
  APP_URL: z.string().default("http://localhost:3000"),

  // PayPal. PAYPAL_API_BASE lets tests point at the local fake PayPal.
  PAYPAL_ENV: z.enum(["sandbox", "live"]).default("sandbox"),
  PAYPAL_CLIENT_ID: z.string().default(""),
  PAYPAL_CLIENT_SECRET: z.string().default(""),
  PAYPAL_WEBHOOK_ID: z.string().default(""),
  PAYPAL_API_BASE: z.string().optional(),

  // AI. AI_PROVIDER picks which key is used; AGENT_MODEL is that provider's model name.
  AI_PROVIDER: z.enum(["anthropic", "google", "groq"]).default("anthropic"),
  ANTHROPIC_API_KEY: z.string().default(""),
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().default(""),
  GROQ_API_KEY: z.string().default(""),
  // Optional: send Gemini/Groq calls through a proxy or a local stand-in.
  AI_BASE_URL: z.string().default(""),
  AGENT_MODEL: z.string().default("claude-sonnet-5-5"),
  SMALL_MODEL: z.string().default("claude-haiku-5-5"),

  // Product data
  CHANNEL3_API_KEY: z.string().default(""),

  // Trust layer secrets
  RULES_SIGNING_KEY: z.string().default(""), // Ed25519 private key as JWK JSON
  CONFIRM_TOKEN_SECRET: z.string().default("dev-only-change-me-please-32-bytes!!"),

  // Render Workflows (production background tasks)
  RENDER_API_KEY: z.string().default(""),
  RENDER_WORKFLOW_SLUG: z.string().default("open-aisle-worker"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    // An empty line like "CONFIRM_TOKEN_SECRET=" in .env means "not set", so the default applies.
    const set = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined && v.trim() !== ""));
    cached = schema.parse(set);
  }
  return cached;
}

/** True when the chosen AI provider has a key, so AI features can switch on. */
export function aiEnabled(): boolean {
  const e = env();
  if (e.AI_PROVIDER === "google") return Boolean(e.GOOGLE_GENERATIVE_AI_API_KEY);
  if (e.AI_PROVIDER === "groq") return Boolean(e.GROQ_API_KEY);
  return Boolean(e.ANTHROPIC_API_KEY);
}

/** Tests change process.env and then call this. */
export function resetEnv() {
  cached = undefined;
}

export function paypalApiBase(): string {
  const e = env();
  if (e.PAYPAL_API_BASE) return e.PAYPAL_API_BASE.replace(/\/$/, "");
  return e.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}
