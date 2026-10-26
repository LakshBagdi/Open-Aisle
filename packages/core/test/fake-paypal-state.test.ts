/**
 * The fake PayPal remembers saved accounts across restarts (like the real
 * one), so `pnpm demo` can be stopped and started without breaking checkout.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePayPal } from "../src/paypal/fake/fakePayPal";

describe("fake PayPal state file", () => {
  it("keeps a saved account after a restart", async () => {
    const stateFile = join(mkdtempSync(join(tmpdir(), "fake-pp-")), "state.json");
    const first = createFakePayPal({ stateFile });
    const url = await first.start();
    const auth = { authorization: `Basic ${Buffer.from("a:b").toString("base64")}` };
    const tok = await (await fetch(`${url}/v1/oauth2/token`, { method: "POST", headers: { ...auth, "content-type": "application/x-www-form-urlencoded" }, body: "grant_type=client_credentials" })).json();
    const headers = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json" };
    const st = await (await fetch(`${url}/v3/vault/setup-tokens`, { method: "POST", headers, body: JSON.stringify({ payment_source: { paypal: { usage_type: "MERCHANT", experience_context: { return_url: "http://x/r", cancel_url: "http://x/c" } } } }) })).json();
    first.approve(st.id);
    const pt = await (await fetch(`${url}/v3/vault/payment-tokens`, { method: "POST", headers, body: JSON.stringify({ payment_source: { token: { id: st.id, type: "SETUP_TOKEN" } } }) })).json();
    expect(pt.id).toBeTruthy();
    await first.stop();

    const second = createFakePayPal({ stateFile });
    expect(second.state.paymentTokens.has(pt.id)).toBe(true);
  });
});
