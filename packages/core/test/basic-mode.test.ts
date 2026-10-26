/**
 * Simple mode: shopping still works with no AI at all (no key, or the AI is
 * down), with the same tools and the same trust layer.
 */
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { parseRequest, pickNumber, runTurn } from "../src/agent";
import { heardRight, pickQuantity } from "../src/agent/basic";
import { closeDb } from "../src/db";
import { isConfirmPhrase, voiceCommand } from "../src/i18n";
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
  it("copes with what speech recognition often mishears", () => {
    expect(pickNumber("add number to")).toBe(2);
    expect(pickNumber("tell me about number one")).toBe(1);
    expect(pickNumber("the 2nd one")).toBe(2);
    expect(parseRequest("size nine and a half").size).toBe("9.5");
    expect(parseRequest("trail shoes size 9.5").size).toBe("9.5");
    expect(parseRequest("a fleece in a medium").size).toBe("m");
    expect(heardRight("by it")).toBe("buy it");
    expect(heardRight("at it")).toBe("add it");
    expect(heardRight("what's in my card")).toBe("what's in my cart");
    expect(heardRight("stand by it")).toBe("stand by it");
    expect(voiceCommand("say it again", "en")).toBe("repeat");
    expect(voiceCommand("help me", "en")).toBe("help");
    // "confirm" as recognisers often write it still confirms; a bare "yes" never pays.
    expect(isConfirmPhrase("Confirmed.", "en")).toBe(true);
    expect(isConfirmPhrase("conform", "en")).toBe(true);
    expect(isConfirmPhrase("yes", "en")).toBe(false);
    expect(isConfirmPhrase("don't confirm", "en")).toBe(false);
  });
  it("understands everyday Hindi in simple mode", async () => {
    const say = async (text: string, conversationId?: string) => runTurn({ userId: world.user.id, text, conversationId });
    const s1 = await say("रनिंग शूज़ 60 डॉलर से कम");
    expect(s1.reply).toContain("Number 1: Trail Runner 2");
    const c = s1.conversationId;
    expect((await say("नंबर एक के बारे में बताओ", c)).reply).toMatch(/^Trail Runner 2 from Northwind Outfitters/);
    expect((await say("इसे साइज़ 9 में जोड़ो", c)).reply).toContain("Added the Trail Runner 2, size 9");
    expect((await say("मेरे कार्ट में क्या है", c)).reply).toMatch(/^In your cart/);
    expect((await say("खरीदो", c)).events.some((e) => e.type === "readback")).toBe(true);
    expect((await say("मेरा ऑर्डर कहाँ है", c)).reply).toBe("You don't have any orders yet.");
  });
  it("a misheard 'by it' still opens the read-back (nothing is paid)", async () => {
    const r1 = await runTurn({ userId: world.user.id, text: "trail running shoes" });
    const added = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "at it in size nine" });
    expect(added.reply).toContain("Added the Trail Runner 2, size 9");
    const r = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "by it" });
    expect(r.events.some((e) => e.type === "readback")).toBe(true);
    expect(fake.state.authorizations.size).toBe(0);
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
    expect(r1.reply).toContain("Number 1: Trail Runner 2, $54.99");

    const r2 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "tell me about number 1" });
    expect(r2.reply).toContain("material: Recycled mesh upper");

    const r3 = await runTurn({ userId: world.user.id, conversationId: r1.conversationId, text: "add number 1" });
    expect(r3.reply).toMatch(/Which size would you like for the Trail Runner 2\? You can choose 8, 9, 10, 11/);

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

  it("understands everyday phrasing", async () => {
    const say = async (text: string, conversationId?: string) => runTurn({ userId: world.user.id, text, conversationId });
    expect((await say("hi")).reply).toMatch(/^Hello!/);
    expect((await say("thanks")).reply).toMatch(/welcome/);
    const s = await say("trail running shoes size 9");
    expect(s.reply).toContain("I found 1");
    const c = s.conversationId;
    expect((await say("what is it made of", c)).reply).toContain("Recycled mesh upper");
    expect((await say("is there a size chart", c)).reply).toContain("27 cm");
    // The size said in the search is remembered, so "add it" doesn't ask again.
    expect((await say("add it", c)).reply).toContain("Added the Trail Runner 2, size 9");
    expect((await say("add it", c)).reply).toMatch(/^Added another Trail Runner 2, size 9\. You now have 2 of them/);
    expect((await say("remove it", c)).reply).toContain("Removed the Trail Runner 2");
    expect((await say("tell me about number 5", c)).reply).toMatch(/I only found one just now: the Trail Runner 2/);
    expect((await say("something under 20 dollars")).reply).toContain("Stoneware Mug, $14.99");
  });

  it("understands the product cards' buttons, which name the product", async () => {
    const say = async (text: string, conversationId?: string) => runTurn({ userId: world.user.id, text, conversationId });
    const s = await say("running shoes");
    expect(s.events.some((e) => e.type === "products")).toBe(true);
    const c = s.conversationId;
    expect((await say("Tell me more about the Trail Runner 2", c)).reply).toMatch(/^Trail Runner 2 from Northwind Outfitters/);
    expect((await say("Add the Trail Runner 2 to my cart", c)).reply).toMatch(/Which size would you like for the Trail Runner 2/);
    expect((await say("9", c)).reply).toContain("Added the Trail Runner 2, size 9");
    // A card from an earlier search still works, and the lookup doesn't show cards again.
    await say("kitchen scale", c);
    const again = await say("Add the Trail Runner 2 to my cart", c);
    expect(again.reply).toMatch(/Which size would you like for the Trail Runner 2/);
    expect(again.events.some((e) => e.type === "products")).toBe(false);
  });

  it("handles the way people really talk about amounts, sizes, colours and the cart", async () => {
    expect(pickQuantity("add two of number 2 in size 10")).toBe(2);
    expect(pickQuantity("add 3 pairs")).toBe(3);
    expect(pickQuantity("add number 2")).toBeUndefined();
    expect(pickQuantity("something under 20 dollars")).toBeUndefined();

    const say = async (text: string, conversationId?: string) => runTurn({ userId: world.user.id, text, conversationId });
    const c = (await say("shoes or mugs")).conversationId;
    await say("trail running shoes", c);
    expect((await say("is it in stock", c)).reply).toMatch(/lists the Trail Runner 2 for sale now/);
    expect((await say("does it come in size 12", c)).reply).toMatch(/^No, the Trail Runner 2 comes in sizes 8, 9, 10, 11/);
    expect((await say("does it come in black", c)).reply).toMatch(/^Yes, the Trail Runner 2 is Black/);
    expect((await say("add two of them in size 10", c)).reply).toMatch(/^Added 2 of the Trail Runner 2, size 10/);
    const changed = await say("change the size to 9", c);
    expect(changed.reply).toMatch(/^Done: the Trail Runner 2 is now size 9/);
    expect((await say("what's in my cart", c)).reply).toMatch(/2 × Trail Runner 2, size 9/);
    // Naming something that isn't in the cart never removes something else.
    expect((await say("remove the scale", c)).reply).toMatch(/^Your cart doesn't have that\. It has: Trail Runner 2/);
    expect((await say("start over", c)).reply).toMatch(/^Okay, let's start again/);
    expect((await say("empty my cart", c)).reply).toBe("Your cart is empty now.");
  });

  it("answers which is cheapest from the last results", async () => {
    const say = async (text: string, conversationId?: string) => runTurn({ userId: world.user.id, text, conversationId });
    const s = await say("something under 100 dollars");
    expect(s.reply).toMatch(/I found 2/);
    expect((await say("which is the cheapest", s.conversationId)).reply).toMatch(/^The cheapest is number \d, the Stoneware Mug, at \$14\.99/);
  });

  it("a stale conversation id starts a fresh conversation instead of failing", async () => {
    const r = await runTurn({ userId: world.user.id, conversationId: "00000000-0000-4000-8000-000000000000", text: "help" });
    expect(r.conversationId).not.toBe("00000000-0000-4000-8000-000000000000");
  });
});
