/**
 * A fake PayPal for local development and automated tests.
 *
 * It speaks the same HTTP API as the PayPal sandbox for the calls Open Aisle
 * makes, and behaves strictly like PayPal on the things that catch bugs:
 *  - an order's total must equal items + tax + shipping (PayPal rejects it otherwise)
 *  - you can't capture a voided hold, or void a captured one
 *  - the same PayPal-Request-Id never creates a second order or capture
 *  - it sends webhooks to our app, signed with a transmission id it can verify
 *
 * Magic amounts for testing failures:
 *  - a total of 666.66 is declined (INSTRUMENT_DECLINED)
 *
 * The real sandbox is still the source of truth: run the same flows there
 * before the demo. This exists so anyone can run Open Aisle with zero keys.
 */
import { randomBytes } from "node:crypto";
import http from "node:http";

type Money = { currency_code: string; value: string };

type SetupToken = { id: string; status: string; returnUrl?: string; cancelUrl?: string; email: string };
type PaymentToken = { id: string; customerId: string; email: string };
type Authorization = { id: string; orderId: string; status: "CREATED" | "VOIDED" | "CAPTURED"; amount: Money; expiration_time: string; customId?: string };
type Capture = { id: string; authorizationId: string; orderId: string; status: "COMPLETED" | "REFUNDED" | "PARTIALLY_REFUNDED"; amount: Money; create_time: string; refundedCents: number };
type Refund = { id: string; captureId: string; status: "COMPLETED"; amount: Money; create_time: string };
type Order = { id: string; intent: string; status: string; purchase_units: any[]; create_time: string; tracking: any[] };

export type FakePayPalOptions = {
  port?: number;
  /** Where to send webhooks, e.g. http://localhost:3000/api/paypal/webhook */
  webhookUrl?: string;
  webhookId?: string;
  /** Delay before a webhook is sent, like the real network. */
  webhookDelayMs?: number;
  payerEmail?: string;
  log?: boolean;
};

const id = (prefix: string) => `${prefix}-${randomBytes(6).toString("hex").toUpperCase()}`;
const cents = (v: string) => Math.round(Number(v) * 100);

export function createFakePayPal(opts: FakePayPalOptions = {}) {
  const state = {
    setupTokens: new Map<string, SetupToken>(),
    paymentTokens: new Map<string, PaymentToken>(),
    orders: new Map<string, Order>(),
    authorizations: new Map<string, Authorization>(),
    captures: new Map<string, Capture>(),
    refunds: new Map<string, Refund>(),
    idempotency: new Map<string, { status: number; body: unknown }>(),
    sentTransmissions: new Set<string>(),
    webhooksSent: [] as { event_type: string; resourceId: string; status?: number }[],
  };
  let baseUrl = "";
  const webhookId = opts.webhookId ?? "FAKE-WEBHOOK-ID";

  function log(...args: unknown[]) {
    if (opts.log) console.log("[fake-paypal]", ...args);
  }

  function err(status: number, name: string, issue: string, message: string) {
    return { status, body: { name, message, debug_id: id("DBG"), details: [{ issue, description: message }] } };
  }

  function emit(eventType: string, resource: Record<string, unknown>) {
    if (!opts.webhookUrl) return;
    const transmissionId = id("TX");
    state.sentTransmissions.add(transmissionId);
    const event = {
      id: id("WH"),
      event_version: "1.0",
      create_time: new Date().toISOString(),
      resource_type: eventType.split(".")[1]?.toLowerCase(),
      event_type: eventType,
      summary: eventType,
      resource,
    };
    const record: { event_type: string; resourceId: string; status?: number } = { event_type: eventType, resourceId: String(resource.id) };
    state.webhooksSent.push(record);
    setTimeout(async () => {
      try {
        const res = await fetch(opts.webhookUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "paypal-transmission-id": transmissionId,
            "paypal-transmission-time": new Date().toISOString(),
            "paypal-transmission-sig": "fake-signature",
            "paypal-cert-url": `${baseUrl}/fake/cert.pem`,
            "paypal-auth-algo": "SHA256withRSA",
          },
          body: JSON.stringify(event),
        });
        record.status = res.status;
        log("webhook", eventType, "→", res.status);
      } catch (e) {
        record.status = 0;
        log("webhook failed", eventType, (e as Error).message);
      }
    }, opts.webhookDelayMs ?? 50);
  }

  function orderView(o: Order) {
    return { id: o.id, intent: o.intent, status: o.status, create_time: o.create_time, purchase_units: o.purchase_units, links: [{ rel: "self", href: `${baseUrl}/v2/checkout/orders/${o.id}`, method: "GET" }] };
  }

  function authView(a: Authorization) {
    return {
      id: a.id,
      status: a.status,
      amount: a.amount,
      custom_id: a.customId,
      expiration_time: a.expiration_time,
      links: [
        { rel: "capture", href: `${baseUrl}/v2/payments/authorizations/${a.id}/capture`, method: "POST" },
        { rel: "void", href: `${baseUrl}/v2/payments/authorizations/${a.id}/void`, method: "POST" },
      ],
    };
  }

  function captureView(c: Capture) {
    return {
      id: c.id,
      status: c.status,
      amount: c.amount,
      final_capture: true,
      create_time: c.create_time,
      supplementary_data: { related_ids: { order_id: c.orderId, authorization_id: c.authorizationId } },
      links: [{ rel: "up", href: `${baseUrl}/v2/payments/authorizations/${c.authorizationId}`, method: "GET" }],
    };
  }

  // ─── route handlers ───────────────────────────────────────────────────

  function createOrder(body: any) {
    if (body?.intent !== "AUTHORIZE" && body?.intent !== "CAPTURE") return err(400, "INVALID_REQUEST", "INVALID_PARAMETER_VALUE", "intent must be AUTHORIZE or CAPTURE");
    const pu = body.purchase_units?.[0];
    if (!pu?.amount?.value) return err(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "purchase_units[0].amount is required");
    const total = cents(pu.amount.value);
    const b = pu.amount.breakdown;
    if (b) {
      const sum = cents(b.item_total?.value ?? "0") + cents(b.tax_total?.value ?? "0") + cents(b.shipping?.value ?? "0") + cents(b.handling?.value ?? "0") - cents(b.discount?.value ?? "0");
      if (sum !== total) return err(422, "UNPROCESSABLE_ENTITY", "AMOUNT_MISMATCH", `Total ${pu.amount.value} does not equal breakdown sum ${(sum / 100).toFixed(2)}`);
      if (pu.items?.length) {
        const itemSum = pu.items.reduce((s: number, i: any) => s + cents(i.unit_amount.value) * Number(i.quantity), 0);
        if (itemSum !== cents(b.item_total?.value ?? "0")) return err(422, "UNPROCESSABLE_ENTITY", "ITEM_TOTAL_MISMATCH", "Items do not add up to item_total");
      }
    }
    const vaultId = body.payment_source?.paypal?.vault_id;
    if (!vaultId) return err(422, "UNPROCESSABLE_ENTITY", "PAYER_ACTION_REQUIRED", "This fake only supports paying with a saved PayPal account (vault_id)");
    if (!state.paymentTokens.has(vaultId)) return err(422, "UNPROCESSABLE_ENTITY", "INVALID_VAULT_ID", "Unknown vault_id");
    if (pu.amount.value === "666.66") return err(422, "UNPROCESSABLE_ENTITY", "INSTRUMENT_DECLINED", "The instrument presented was declined.");

    const order: Order = { id: id("ORDER"), intent: body.intent, status: "COMPLETED", create_time: new Date().toISOString(), purchase_units: [], tracking: [] };
    const auth: Authorization = {
      id: id("AUTH"),
      orderId: order.id,
      status: "CREATED",
      amount: { currency_code: pu.amount.currency_code, value: pu.amount.value },
      expiration_time: new Date(Date.now() + 29 * 864e5).toISOString(),
      customId: pu.custom_id,
    };
    state.authorizations.set(auth.id, auth);
    order.purchase_units = [{ reference_id: pu.reference_id ?? "default", custom_id: pu.custom_id, amount: pu.amount, items: pu.items ?? [], payments: { authorizations: [authView(auth)] } }];
    state.orders.set(order.id, order);
    emit("PAYMENT.AUTHORIZATION.CREATED", authView(auth));
    return { status: 201, body: orderView(order) };
  }

  function voidAuth(authId: string) {
    const a = state.authorizations.get(authId);
    if (!a) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Authorization not found");
    if (a.status === "CAPTURED") return err(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_CAPTURED", "Authorization has been previously captured and hence cannot be voided.");
    if (a.status === "VOIDED") return err(422, "UNPROCESSABLE_ENTITY", "PREVIOUSLY_VOIDED", "Authorization has been previously voided.");
    a.status = "VOIDED";
    emit("PAYMENT.AUTHORIZATION.VOIDED", authView(a));
    return { status: 200, body: authView(a) };
  }

  function captureAuth(authId: string) {
    const a = state.authorizations.get(authId);
    if (!a) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Authorization not found");
    if (a.status === "VOIDED") return err(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_VOIDED", "A voided authorization cannot be captured.");
    if (a.status === "CAPTURED") return err(422, "UNPROCESSABLE_ENTITY", "AUTHORIZATION_ALREADY_CAPTURED", "Authorization has been previously captured.");
    a.status = "CAPTURED";
    const c: Capture = { id: id("CAP"), authorizationId: a.id, orderId: a.orderId, status: "COMPLETED", amount: a.amount, create_time: new Date().toISOString(), refundedCents: 0 };
    state.captures.set(c.id, c);
    emit("PAYMENT.CAPTURE.COMPLETED", captureView(c));
    return { status: 201, body: captureView(c) };
  }

  function refundCapture(captureId: string, body: any) {
    const c = state.captures.get(captureId);
    if (!c) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Capture not found");
    const amount: Money = body?.amount ?? c.amount;
    const want = cents(amount.value);
    if (c.refundedCents + want > cents(c.amount.value)) return err(422, "UNPROCESSABLE_ENTITY", "REFUND_AMOUNT_EXCEEDED", "Refund amount exceeds the captured amount.");
    c.refundedCents += want;
    c.status = c.refundedCents === cents(c.amount.value) ? "REFUNDED" : "PARTIALLY_REFUNDED";
    const r: Refund = { id: id("REF"), captureId: c.id, status: "COMPLETED", amount, create_time: new Date().toISOString() };
    state.refunds.set(r.id, r);
    const view = { id: r.id, status: r.status, amount: r.amount, create_time: r.create_time, links: [{ rel: "up", href: `${baseUrl}/v2/payments/captures/${c.id}`, method: "GET" }] };
    emit("PAYMENT.CAPTURE.REFUNDED", view);
    return { status: 201, body: view };
  }

  async function route(method: string, path: string, query: URLSearchParams, body: any, headers: http.IncomingHttpHeaders): Promise<{ status: number; body?: unknown; html?: string; redirect?: string }> {
    // Approval page (what the person sees when saving PayPal for the first time).
    let m = path.match(/^\/fake\/approve\/([\w-]+)$/);
    if (m) {
      const st = state.setupTokens.get(m[1]!);
      if (!st) return { status: 404, html: "<h1>Unknown setup token</h1>" };
      if (method === "POST" || query.get("auto") === "1") {
        const decision = (body?.decision as string) ?? query.get("decision") ?? "approve";
        if (decision === "cancel") return { status: 303, redirect: st.cancelUrl ?? "/" };
        st.status = "APPROVED";
        const back = new URL(st.returnUrl ?? "http://localhost:3000/");
        back.searchParams.set("approval_token_id", st.id);
        back.searchParams.set("approval_session_id", id("SESSION"));
        return { status: 303, redirect: back.toString() };
      }
      return { status: 200, html: approvalPage(st) };
    }

    if (path === "/fake/state") {
      return { status: 200, body: { webhooksSent: state.webhooksSent, authorizations: [...state.authorizations.values()], captures: [...state.captures.values()], refunds: [...state.refunds.values()] } };
    }

    if (method === "POST" && path === "/v1/oauth2/token") {
      if (!String(headers.authorization ?? "").startsWith("Basic ")) return err(401, "AUTHENTICATION_FAILURE", "INVALID_CLIENT", "Client authentication failed");
      return { status: 200, body: { access_token: id("A21AA"), token_type: "Bearer", expires_in: 32400, app_id: "APP-FAKE", scope: "https://uri.paypal.com/services/payments" } };
    }

    // Everything else needs a bearer token.
    if (!String(headers.authorization ?? "").startsWith("Bearer ")) return err(401, "AUTHENTICATION_FAILURE", "INVALID_TOKEN", "Authentication failed due to missing token");

    if (method === "POST" && path === "/v3/vault/setup-tokens") {
      const pp = body?.payment_source?.paypal;
      if (!pp) return err(400, "INVALID_REQUEST", "MISSING_REQUIRED_PARAMETER", "payment_source.paypal is required");
      const st: SetupToken = { id: id("ST"), status: "PAYER_ACTION_REQUIRED", returnUrl: pp.experience_context?.return_url, cancelUrl: pp.experience_context?.cancel_url, email: opts.payerEmail ?? "asha.buyer@example.com" };
      state.setupTokens.set(st.id, st);
      return {
        status: 201,
        body: { id: st.id, status: st.status, payment_source: { paypal: { usage_type: pp.usage_type } }, links: [{ rel: "approve", href: `${baseUrl}/fake/approve/${st.id}`, method: "GET" }, { rel: "confirm", href: `${baseUrl}/v3/vault/payment-tokens`, method: "POST" }] },
      };
    }

    if (method === "POST" && path === "/v3/vault/payment-tokens") {
      const stId = body?.payment_source?.token?.id;
      const st = state.setupTokens.get(stId);
      if (!st) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Setup token not found");
      if (st.status !== "APPROVED") return err(422, "UNPROCESSABLE_ENTITY", "TOKEN_NOT_APPROVED", "The payer has not approved this setup token yet.");
      const pt: PaymentToken = { id: id("PT"), customerId: id("CUST"), email: st.email };
      state.paymentTokens.set(pt.id, pt);
      st.status = "VAULTED";
      const view = { id: pt.id, customer: { id: pt.customerId }, payment_source: { paypal: { email_address: pt.email, usage_type: "MERCHANT" } } };
      emit("VAULT.PAYMENT-TOKEN.CREATED", view);
      return { status: 201, body: view };
    }

    if (method === "POST" && path === "/v2/checkout/orders") return createOrder(body);

    m = path.match(/^\/v2\/checkout\/orders\/([\w-]+)$/);
    if (m && method === "GET") {
      const o = state.orders.get(m[1]!);
      return o ? { status: 200, body: orderView(o) } : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found");
    }

    m = path.match(/^\/v2\/checkout\/orders\/([\w-]+)\/authorize$/);
    if (m && method === "POST") {
      const o = state.orders.get(m[1]!);
      return o ? { status: 201, body: orderView(o) } : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found");
    }

    m = path.match(/^\/v2\/checkout\/orders\/([\w-]+)\/track$/);
    if (m && method === "POST") {
      const o = state.orders.get(m[1]!);
      if (!o) return err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Order not found");
      if (!state.captures.has(body?.capture_id)) return err(422, "UNPROCESSABLE_ENTITY", "CAPTURE_ID_NOT_FOUND", "capture_id is not a capture of this order");
      o.tracking.push({ tracking_number: body.tracking_number, carrier: body.carrier, status: "SHIPPED" });
      o.purchase_units[0].shipping = { trackers: o.tracking.map((t, i) => ({ id: `${body.capture_id}-${i}`, status: t.status, tracking_number: t.tracking_number, carrier: t.carrier })) };
      return { status: 201, body: orderView(o) };
    }

    m = path.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/void$/);
    if (m && method === "POST") return voidAuth(m[1]!);

    m = path.match(/^\/v2\/payments\/authorizations\/([\w-]+)\/capture$/);
    if (m && method === "POST") return captureAuth(m[1]!);

    m = path.match(/^\/v2\/payments\/authorizations\/([\w-]+)$/);
    if (m && method === "GET") {
      const a = state.authorizations.get(m[1]!);
      return a ? { status: 200, body: authView(a) } : err(404, "RESOURCE_NOT_FOUND", "INVALID_RESOURCE_ID", "Authorization not found");
    }

    m = path.match(/^\/v2\/payments\/captures\/([\w-]+)\/refund$/);
    if (m && method === "POST") return refundCapture(m[1]!, body);

    if (method === "GET" && path === "/v1/reporting/transactions") {
      const details = [...state.captures.values()].map((c) => ({
        transaction_info: { transaction_id: c.id, transaction_status: "S", transaction_initiation_date: c.create_time, transaction_amount: c.amount },
      }));
      return { status: 200, body: { transaction_details: details, page: 1, total_items: details.length, total_pages: 1 } };
    }

    if (method === "POST" && path === "/v1/notifications/verify-webhook-signature") {
      const ok = body?.webhook_id === webhookId && state.sentTransmissions.has(body?.transmission_id);
      return { status: 200, body: { verification_status: ok ? "SUCCESS" : "FAILURE" } };
    }

    return err(404, "RESOURCE_NOT_FOUND", "NOT_FOUND", `Fake PayPal has no route for ${method} ${path}`);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let body: any;
    if (raw) {
      const type = String(req.headers["content-type"] ?? "");
      body = type.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : safeJson(raw);
    }

    // PayPal-Request-Id: same id + same path → same answer, no second side effect.
    const requestId = req.headers["paypal-request-id"] as string | undefined;
    const idemKey = requestId ? `${req.method} ${url.pathname} ${requestId}` : undefined;
    let out: Awaited<ReturnType<typeof route>>;
    if (idemKey && state.idempotency.has(idemKey)) {
      out = state.idempotency.get(idemKey)!;
    } else {
      out = await route(req.method ?? "GET", url.pathname, url.searchParams, body, req.headers);
      if (idemKey && out.status < 500) state.idempotency.set(idemKey, { status: out.status, body: out.body });
    }
    log(req.method, url.pathname, "→", out.status);

    if (out.redirect) {
      res.writeHead(out.status, { location: out.redirect });
      res.end();
    } else if (out.html !== undefined) {
      res.writeHead(out.status, { "content-type": "text/html; charset=utf-8" });
      res.end(out.html);
    } else {
      res.writeHead(out.status, { "content-type": "application/json", "paypal-debug-id": id("DBG") });
      res.end(out.body === undefined ? "" : JSON.stringify(out.body));
    }
  });

  return {
    state,
    get url() {
      return baseUrl;
    },
    async start() {
      await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : opts.port}`;
      return baseUrl;
    },
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    /** Tests: approve a setup token without a browser. */
    approve(setupTokenId: string) {
      const st = state.setupTokens.get(setupTokenId);
      if (!st) throw new Error("unknown setup token");
      st.status = "APPROVED";
    },
  };
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function approvalPage(st: SetupToken) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake PayPal: approve Open Aisle</title>
<style>body{font:18px/1.5 system-ui,sans-serif;max-width:36rem;margin:3rem auto;padding:0 1rem;color:#111}
.badge{display:inline-block;background:#fde68a;padding:.1rem .5rem;border-radius:.3rem;font-size:.85rem}
button{font:inherit;padding:.75rem 1.25rem;margin:.5rem .5rem 0 0;border-radius:.5rem;border:2px solid #111;cursor:pointer}
button[value=approve]{background:#111;color:#fff}button:focus-visible{outline:4px solid #2563eb;outline-offset:2px}</style></head>
<body><main><p class="badge">Local test only. This is not PayPal.</p>
<h1>Allow Open Aisle to pay with your PayPal</h1>
<p>Account: <strong>${st.email}</strong></p>
<p>Open Aisle will only charge you after you confirm the exact order, and you can cancel within the undo window.</p>
<form method="post"><button name="decision" value="approve" autofocus>Agree and continue</button><button name="decision" value="cancel">Cancel</button></form>
</main></body></html>`;
}
