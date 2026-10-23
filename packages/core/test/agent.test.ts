/**
 * The agent with a scripted model: we decide what "Claude" says and which
 * tools it calls, then check that our code does the right thing around it.
 */
import { MockLanguageModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runTurn } from "../src/agent";
import { checkGrounding, toSpeakable } from "../src/agent/grounding";
import { closeDb, getDb } from "../src/db";
import { barriers, carts } from "../src/db/schema";
import { placeOrder } from "../src/orders";
import { issueConfirmation } from "../src/rules";
import { resetDb, seedWorld, startFakePayPal } from "./helpers";

let fake: Awaited<ReturnType<typeof startFakePayPal>>;
let world: Awaited<ReturnType<typeof seedWorld>>;

beforeAll(async () => {
  fake = await startFakePayPal();
});
afterAll(async () => {
  await fake.stop();
  await closeDb();
});
beforeEach(async () => {
  await resetDb();
  world = await seedWorld(fake);
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};
type Step = { tool: string; input: unknown } | { text: string };

/** A fake Claude that follows a script, one step per model call. */
function scripted(steps: (() => Step)[]) {
  let i = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(i++, steps.length - 1)]!();
      if ("tool" in step) {
        return {
          content: [{ type: "tool-call", toolCallId: `call-${i}`, toolName: step.tool, input: JSON.stringify(step.input) }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: "text", text: step.text }], finishReason: { unified: "stop", raw: undefined }, usage, warnings: [] };
    },
  });
}

describe("agent turn", () => {
  it("searches, adds to cart, asks for the read-back; nothing is paid", async () => {
    const model = scripted([
      () => ({ tool: "search_products", input: { query: "black running shoes", size: "9" } }),
      () => ({ tool: "add_to_cart", input: { product_id: world.shoe.id, options: { size: "9" } } }),
      () => ({ tool: "request_readback", input: {} }),
      () => ({ text: "I found the **Trail Runner 2** for $54.99. I'm reading your order back now." }),
    ]);
    const r = await runTurn({ userId: world.user.id, text: "I need black running shoes, size 9", model });

    expect(r.grounding.passed).toBe(true);
    expect(r.reply).toBe("I found the Trail Runner 2 for $54.99. I'm reading your order back now.");
    const rb = r.events.find((e) => e.type === "readback");
    expect(rb).toBeDefined();
    expect(rb!.type === "readback" && rb!.spoken).toContain("Total $59.53");
    expect(fake.state.authorizations.size).toBe(0); // the agent can't pay

    // The person confirms in the app with the fingerprint of what they heard.
    if (rb?.type !== "readback") throw new Error();
    const { token } = await issueConfirmation(world.user.id, rb.cartId, new Date(), rb.fingerprint);
    const placed = await placeOrder(world.user.id, rb.cartId, token);
    expect(placed.order.status).toBe("held");
  });

  it("catches a made-up price and fixes it on the retry", async () => {
    const model = scripted([
      () => ({ tool: "get_product", input: { product_id: world.shoe.id } }),
      () => ({ text: "The Trail Runner 2 is $39.99." }), // wrong
      () => ({ text: "The Trail Runner 2 is $54.99." }), // retry
    ]);
    const r = await runTurn({ userId: world.user.id, text: "How much is it?", model });
    expect(r.reply).toBe("The Trail Runner 2 is $54.99.");
    expect(r.grounding.passed).toBe(true);
    expect(r.grounding.problems.join()).toContain("$39.99");
  });

  it("removes a false claim that it paid, if the retry still says it", async () => {
    const model = scripted([() => ({ text: "Great news, I've placed your order and paid $54.99." })]);
    const r = await runTurn({ userId: world.user.id, text: "buy it", model });
    expect(r.grounding.passed).toBe(false);
    expect(r.reply).not.toMatch(/placed your order/);
    expect(r.reply).toMatch(/couldn't confirm/);
  });

  it("hears about over-limit carts before confirming", async () => {
    await resetDb();
    world = await seedWorld(fake, { perOrderCents: 3000, monthlyCents: 20_000 });
    const model = scripted([
      () => ({ tool: "add_to_cart", input: { product_id: world.shoe.id, options: { size: "9" } } }),
      () => ({ tool: "request_readback", input: {} }),
      () => ({ text: "That order is over your per-order limit, so I can't send it for confirmation." }),
    ]);
    const r = await runTurn({ userId: world.user.id, text: "buy the shoes", model });
    const rb = r.events.find((e) => e.type === "readback");
    expect(rb?.type === "readback" && rb.blockedReason).toMatch(/over your limit/);
  });

  it("logs a barrier when a product is missing information", async () => {
    const model = scripted([() => ({ tool: "get_product", input: { product_id: world.mug.id } }), () => ({ text: "The store didn't describe the photo." })]);
    await runTurn({ userId: world.user.id, text: "tell me about the mug", model });
    const rows = await getDb().select().from(barriers).where(eq(barriers.productId, world.mug.id));
    expect(rows.map((b) => b.kind)).toContain("missing_alt_text");
    expect(rows[0]!.timesHit).toBe(1);
  });

  it("asks for a size instead of guessing one", async () => {
    const model = scripted([
      () => ({ tool: "add_to_cart", input: { product_id: world.shoe.id, options: {} } }),
      () => ({ text: "Which size would you like? It comes in 8, 9, 10 and 11." }),
    ]);
    const r = await runTurn({ userId: world.user.id, text: "add the trail runner", model });
    expect(r.reply).toMatch(/Which size/);
    const open = await getDb().select().from(carts).where(eq(carts.userId, world.user.id));
    expect(open.every((c) => c.items.length === 0)).toBe(true);
  });

  it("remembers earlier turns", async () => {
    const m1 = scripted([() => ({ tool: "search_products", input: { query: "running shoes" } }), () => ({ text: "I found the Trail Runner 2 for $54.99." })]);
    const first = await runTurn({ userId: world.user.id, text: "running shoes", model: m1 });
    const m2 = scripted([() => ({ text: "Yes, it's $54.99." })]);
    const second = await runTurn({ userId: world.user.id, text: "what was the price again?", conversationId: first.conversationId, model: m2 });
    expect(second.grounding.passed).toBe(true); // $54.99 is grounded by the first turn's tool result
  });
});

describe("grounding check", () => {
  const facts = JSON.stringify({ price: "$54.99", facts: { weight: "260 g per shoe" }, size_chart: "9 = 26.5 cm" });
  it("accepts facts from tools", () => {
    expect(checkGrounding("It costs $54.99, weighs 260 g, and size 9 is 26.5 cm.", facts, false).passed).toBe(true);
  });
  it("rejects invented numbers", () => {
    const r = checkGrounding("It costs $49 and weighs 300 g.", facts, false);
    expect(r.problems).toHaveLength(2);
  });
  it("strips markdown a screen reader would read aloud", () => {
    expect(toSpeakable("**Bold** and\n- a list\n# Heading")).toBe("Bold and\na list\nHeading");
  });
});
