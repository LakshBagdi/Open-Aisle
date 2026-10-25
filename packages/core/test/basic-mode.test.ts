/**
 * Simple mode: shopping still works with no AI at all (no key, or the AI is
 * down), with the same tools and the same trust layer.
 */
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseRequest, pickNumber, runTurn } from "../src/agent";
import { closeDb } from "../src/db";
import { voiceCommand } from "../src/i18n";
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

describe("understanding short requests", () => {
  it("reads size, price and colour", () => {
    expect(parseRequest("Black running shoes, size 9, under 60 dollars")).toMatchObject({ size: "9", maxPrice: 60, color: "black" });
    expect(parseRequest("find me a kitchen scale").query).toBe("kitchen scale");
  });
  it("reads which one", () => {
    expect(pickNumber("add number 2, size 9")).toBe(2);
    expect(pickNumber("the second one")).toBe(2);
    expect(pickNumber("tell me about the last one")).toBe(-1);
    expect(pickNumber("running shoes")).toBeUndefined();
  });
  it("recognises whole-phrase voice commands only", () => {
    expect(voiceCommand("Cancel that.", "en")).toBe("cancel");
    expect(voiceCommand("don't cancel that", "en")).toBeNull();
    expect(voiceCommand("रद्द करो", "hi")).toBe("cancel");
    expect(voiceCommand("say that again", "en")).toBe("repeat");
  });
});

describe("a whole purchase in simple mode", () => {
  it("search → details → add → read-back; nothing is paid", async () => {
    const r1 = await runTurn({ userId: world.user.id, text: "trail running shoes under 60" });
    expect(r1.mode).toBe("basic");
    expect(r1.reply).toContain("Number 1: Trail Runner 2");
    expect(r1.reply).toContain("$54.99");

    const r2 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "tell me about number 1" });
    expect(r2.reply).toContain("material: Recycled mesh upper");

    const r3 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "add number 1" });
    expect(r3.reply).toMatch(/Which size .* Options: 8, 9, 10, 11/);

    const r4 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "9" });
    expect(r4.reply).toContain("Added the Trail Runner 2, size 9");
    expect(r4.events.some((e) => e.type === "cart_updated")).toBe(true);

    const r5 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "buy it" });
    const rb = r5.events.find((e) => e.type === "readback");
    expect(rb && rb.type === "readback" && rb.spoken).toContain("Total $59.53");
    expect(fake.state.authorizations.size).toBe(0);
  });

  it("cancels inside the undo window", async () => {
    const r1 = await runTurn({ userId: world.user.id, text: "trail running shoes" });
    await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "add number 1, size 9" });
    const rb = (await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "checkout" })).events.find((e) => e.type === "readback");
    const cartId = rb && rb.type === "readback" ? rb.cartId : "";
    await placeOrder(world.user.id, cartId, (await issueConfirmation(world.user.id, cartId)).token);

    const r = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "cancel that" });
    expect(r.reply).toBe("Cancelled. Nothing was charged.");
    expect(r.events.some((e) => e.type === "order_cancelled")).toBe(true);
  });

  it("answers about orders and spending, and offers help", async () => {
    expect((await runTurn({ userId: world.user.id, text: "where's my order" })).reply).toBe("You don't have any orders yet.");
    expect((await runTurn({ userId: world.user.id, text: "how much have I spent" })).reply).toMatch(/spent \$0\.00.*\$300\.00 left/);
    expect((await runTurn({ userId: world.user.id, text: "help" })).reply).toContain("simple mode");
  });
});

describe("falling back when the AI fails", () => {
  it("uses simple mode for that turn and says so", async () => {
    const broken = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("503 overloaded");
      },
    });
    const r = await runTurn({ userId: world.user.id, text: "trail running shoes", model: broken });
    expect(r.mode).toBe("basic");
    expect(r.reply).toMatch(/^The AI isn't reachable right now, so I'm in simple mode\. I found 1/);
  });

  it("a stale conversation id starts a fresh conversation instead of failing", async () => {
    const r = await runTurn({ userId: world.user.id, conversationId: "00000000-0000-4000-8000-000000000000", text: "help" });
    expect(r.conversationId).not.toBe("00000000-0000-4000-8000-000000000000");
  });
});
