/**
 * Another AI agent shopping through Open Aisle over MCP: it can search and
 * fill the cart, but checkout only produces a link. Paying still needs the
 * person's confirmation of the exact cart.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { closeDb } from "@open-aisle/core";
import { placeOrder } from "@open-aisle/core/orders";
import { ConfirmationError, issueConfirmation } from "@open-aisle/core/rules";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetDb, seedWorld, startFakePayPal } from "../../../packages/core/test/helpers";
import { createOpenAisleMcp } from "../src/shop";

let fake: Awaited<ReturnType<typeof startFakePayPal>>;
let world: Awaited<ReturnType<typeof seedWorld>>;
let client: Client;

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
  const server = createOpenAisleMcp({ userId: world.user.id, appUrl: "http://shop.test" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

const json = (r: unknown) => JSON.parse(((r as { content: { text: string }[] }).content[0]!).text);

describe("Open Aisle over MCP", () => {
  it("offers shopping tools and no way to pay", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_products", "add_to_cart", "checkout", "cancel_order"]));
    expect(names.some((n) => /pay|confirm|place_order|capture/.test(n))).toBe(false);
    expect(names).not.toContain("describe_photo"); // needs a model; none given
  });

  it("search → cart → checkout gives a link; only the person's confirm pays", async () => {
    const found = json(await client.callTool({ name: "search_products", arguments: { query: "trail running shoes", size: "9" } }));
    const id = found.results[0].product_id;
    await client.callTool({ name: "add_to_cart", arguments: { product_id: id, options: { size: "9" } } });
    const out = json(await client.callTool({ name: "checkout", arguments: {} }));
    expect(out.status).toBe("waiting_for_person");
    expect(out.read_back).toContain("$59.53");
    const url = new URL(out.confirm_url);
    expect(url.origin).toBe("http://shop.test");
    const cartId = url.pathname.split("/").pop()!;
    const fp = url.searchParams.get("fp")!;
    expect(fake.state.authorizations.size).toBe(0); // nothing held yet

    // What the confirm page does when the person presses Confirm:
    const { token } = await issueConfirmation(world.user.id, cartId, new Date(), fp);
    const { order } = await placeOrder(world.user.id, cartId, token);
    expect(order.status).toBe("held");
  });

  it("a link for a cart that changed afterwards can't be used", async () => {
    const found = json(await client.callTool({ name: "search_products", arguments: { query: "trail running shoes" } }));
    await client.callTool({ name: "add_to_cart", arguments: { product_id: found.results[0].product_id, options: { size: "9" } } });
    const out = json(await client.callTool({ name: "checkout", arguments: {} }));
    const url = new URL(out.confirm_url);
    // The agent sneaks another item in after the read-back.
    await client.callTool({ name: "add_to_cart", arguments: { product_id: found.results[0].product_id, options: { size: "10" } } });
    await expect(issueConfirmation(world.user.id, url.pathname.split("/").pop()!, new Date(), url.searchParams.get("fp")!)).rejects.toBeInstanceOf(ConfirmationError);
  });
});
