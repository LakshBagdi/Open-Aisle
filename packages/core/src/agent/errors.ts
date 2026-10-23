/**
 * Turn an AI provider failure into a sentence the person can act on, and a
 * one-line log the developer can act on. Without this every provider problem
 * (retired model, bad key, free-tier rate limit) looked the same to the
 * shopper: "Something went wrong on our side."
 */
import { APICallError, RetryError } from "ai";

export function describeAiError(err: unknown): string | undefined {
  let e: unknown = err;
  if (RetryError.isInstance(e)) e = e.lastError;
  if (!APICallError.isInstance(e)) return undefined;

  const status = e.statusCode ?? 0;
  const detail = (e.message || "").split("\n")[0]!.slice(0, 300);
  console.error(`[open-aisle] AI provider error ${status} from ${e.url}: ${detail}`);

  if (status === 429) return "I'm getting too many requests right now. Please wait a minute and try again. Nothing was charged.";
  if (status === 401 || status === 403 || /api key/i.test(detail)) {
    return "I can't think right now because the AI key on the server isn't working. Nothing was charged.";
  }
  if (status === 404) return "I can't think right now because the AI model set on the server isn't available. Nothing was charged.";
  if (status >= 500) return "The AI service is having trouble right now. Please try again in a moment. Nothing was charged.";
  return "I couldn't get an answer from the AI service. Please try again. Nothing was charged.";
}
