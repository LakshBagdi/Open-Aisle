# Open Aisle

**Shopping, open to everyone.** An AI shopping companion for people the web leaves out: blind and low-vision people, people who can't use a mouse or touch screen, people who find checkout forms confusing, and people shopping outside their first language. They say what they need; Open Aisle finds it, describes it honestly, reads the exact order back, and pays with PayPal only after a clear yes.

And for stores: every time a shopper needs information the store didn't give, Open Aisle counts it, drafts the fix, and shows what accessibility is worth in sales.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) 2026. MIT licence.

## The problem

- A Swiss study found **34% of online shops tested completely shut out people with disabilities**; screen-reader users often couldn't finish checkout at all.
- In a European survey, **9% of people said they need help to pay online**; language barriers hit migrants and people with intellectual disabilities hardest.
- A CHI 2026 study of blind shoppers using a voice AI agent found two fears: **they couldn't check what the AI told them, and handing it payment felt unsafe.**

Other shopping agents are built for people who can see what the agent did. Open Aisle is built for people who can't.

## Three promises, enforced by code

1. **Never guess.** Every price, size and material the agent says must appear in the store's own data. A grounding check reads each reply before it's spoken; anything not in a tool result is sent back for a rewrite, then removed. Photo descriptions are always labelled "from the photo".
2. **Never pay without a clear yes.** The agent has *no tool that pays*. When the person wants to buy, code builds a read-back of the exact cart. Only the person's Confirm (button, or the spoken word "confirm" while the read-back is open) creates a one-time confirmation token. The token is tied to a fingerprint of the exact cart heard, expires in 2 minutes, works once, and checks signed spending limits.
3. **Mistakes can be undone.** Payment is a PayPal *authorization hold*, not a charge. During the undo window (default 10 minutes) "cancel that" voids the hold and nothing is charged. When the window ends, a Render Workflows task captures it.

## Three ways to use it

On the first visit Open Aisle asks how you want to use it (change it any time in Settings):

- **Talk and listen.** Press the yellow **Talk** button, **Space** anywhere on the Shop page, or **Alt+T** from anywhere (even in the text box or the read-back; in screen-reader mode only Alt+T, because screen readers pass Space through while reading), say what you need, and hear the answer. A rising tone means "listening", a falling one "got it". **Hands-free** (on by default) listens again after every reply, and silence ends it quietly, so a whole purchase needs no buttons: "black running shoes size 9" → "add number 1" → "buy it" → "confirm" → "cancel that". Short commands (confirm, change, don't order, cancel that, repeat, stop, help) are handled instantly in the browser, not by the AI. Speaking speed is adjustable.
- **Screen reader.** Replies go to a live region your screen reader (NVDA, JAWS, VoiceOver, TalkBack) reads; Open Aisle stays quiet so there aren't two voices. Every page passes WCAG 2.2 AA checks.
- **Read and type.** Large Atkinson Hyperlegible text, Enter to send.

If you speak a request, the answer is spoken even with read-aloud off, unless you use a screen reader. Voice uses the browser's own speech (Chrome, Edge, Safari); no audio leaves the browser except the recognised words.

**Simple mode:** with no Anthropic key, or if the AI service is down, shopping still works with short requests ("running shoes under 60", "tell me about number 2", "add number 1, size 9", "buy it", "cancel that"). Same tools, same read-back, same trust layer.

## What's in it

| For | Page / part | What it does |
| --- | --- | --- |
| Shoppers | **Shop** (`/`) | Talk or type. Claude finds products (max 3 at a time), describes photos honestly, compares, checks prices, fills the cart, asks for the read-back. English and Hindi. |
| | Read-back dialog | The exact order, written by code, focus on the order not the button. "Confirm and pay $59.53". |
| | **My orders**, **Settings** | Order history (accessible AG Grid), spending limits (signed), undo window, PayPal connection, plain-words mode, large text. |
| Any AI agent | **MCP server** (`pnpm mcp`) | Claude Desktop or any MCP client can shop with Open Aisle. `checkout` returns a confirm link; the person confirms on Open Aisle's own page (`/confirm/...`). The trust layer travels with the shopper. |
| Stores | **Barrier report** | Missing information shoppers hit, most-hit first (AG Grid), with an AI-drafted fix. |
| | **Fix board** | The same barriers as a Bryntum TaskBoard: Needs a fix → Being fixed → Fixed. A card only reaches Fixed when real information is written into the catalog. |
| | **Insights** | AG Studio dashboard: paid via PayPal, mistakes caught by the undo window, barrier hits. Its AI assistant (running on Claude) builds charts from questions. |
| | **Merchant API** (`/api/v1`) | Ship (PayPal tracking), refund (PayPal refund), barriers, fixes, insights. Per-store keys. OpenAPI file → SDKs with APIMatic. |

## How PayPal is used

| Step | PayPal | What the person hears |
| --- | --- | --- |
| Connect once | Vault: `POST /v3/vault/setup-tokens` → approval → `POST /v3/vault/payment-tokens` | "Your PayPal is connected." |
| Hold | Orders v2, `intent: AUTHORIZE`, paid with the vaulted token | "Order placed. The money is held, not taken." |
| Change of mind | `POST /v2/payments/authorizations/{id}/void` | "Cancelled. Nothing was charged." |
| Charge | `POST /v2/payments/authorizations/{id}/capture` | "Done. You paid $59.53 to Northwind Outfitters." |
| Ship (store, Merchant API) | `POST /v2/checkout/orders/{id}/track` | "It's on its way, arriving Thursday." |
| Return / refund | `POST /v2/payments/captures/{id}/refund` | "Northwind refunded $59.53 to your PayPal." |
| Updates | Webhooks, verified with `verify-webhook-signature`, stored once by event id | Spoken updates |

All of these go through the official **PayPal Server SDK** (`@paypal/paypal-server-sdk`, generated by APIMatic), except webhook verification, which the SDK doesn't cover. Every call that moves money carries a fixed `PayPal-Request-Id`, so a retry can never charge twice.

## How AI is used

| Tool | Used for |
| --- | --- |
| Claude Sonnet (`claude-sonnet-5-5`) via the Vercel AI SDK | The shopping agent: understands requests in English and Hindi, calls 13 tools (search, product facts, photo, compare, price check, cart, read-back, cancel, orders, spending, returns) |
| Claude vision | Describing product photos that stores didn't describe, and drafting photo descriptions for merchants |
| Claude inside AG Studio | The insights dashboard's AI assistant: AG Studio's agents send each step to our server, which runs it on Claude and returns tool calls for the dashboard |
| Grounding check (our code) | Blocks any price or measurement not found in a tool result |
| Browser Web Speech API | Voice input and spoken replies, no extra service |
| Simple mode (our code) | Rule-based understanding of short requests when no AI is available, using the same tools |

## Sponsor tools

- **AG Grid**: accessible grids for order history and the barrier report, and **AG Studio** for the store insights dashboard, with its AI assistant powered by Claude.
- **Bryntum**: TaskBoard for the store's fix board, in Bryntum's high-contrast theme.
- **APIMatic**: the PayPal Server SDK we call is APIMatic-generated, and our own Merchant API ships an APIMatic project (`apimatic/`) plus a workflow that generates TypeScript, Python and Java SDKs.
- **Render**: hosting, Postgres, and **Render Workflows** for the durable undo-window capture.
- **Channel3**: real product data for catalogs and live "is this a fair price?" checks.

## Run it

Requirements: Node 22+, pnpm 10, PostgreSQL 16, running. The default `.env` expects user, password and database all named `openaisle`; change `DATABASE_URL` if yours differ.

```bash
pnpm install
pnpm demo              # http://localhost:3000
```

That's it. `pnpm demo` makes `.env` from `.env.example` if you don't have one, sets up the database, and starts the app together with a fake PayPal, so it works with **no keys at all**. The first time, it also fills in 2 demo stores, 15 products, the demo shopper "Asha" and some simulated shoppers, so the store pages have numbers; after that it keeps your orders (`pnpm db:seed` starts the demo over). Without an AI key the assistant runs in *simple mode*: it understands short requests ("running shoes under 60", "add number 1", "buy it", "cancel that"); add a key to `.env` for full conversation.

Everything lives in one `.env` at the top of the repo. To use the real PayPal sandbox instead of the fake, put your sandbox `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env` and remove the `PAYPAL_API_BASE` line. Different database? Change `DATABASE_URL`.

Other commands: `pnpm db:setup` (set up and refill the database only), `pnpm demo:activity` (more simulated shoppers), `pnpm fake-paypal` and `pnpm dev` (run the two parts yourself). The fake PayPal remembers connected accounts between restarts, like the real one.

The fake PayPal speaks the same API as the sandbox for every call Open Aisle makes, and is just as strict: totals must add up, voided holds can't be captured, request ids are idempotent, and it sends webhooks.

**No Claude key?** Gemini and Groq both have free tiers. Set `AI_PROVIDER=google`, `GOOGLE_GENERATIVE_AI_API_KEY=...` and `AGENT_MODEL=gemini-3.8-flash` (or `AI_PROVIDER=groq`, `GROQ_API_KEY=...`). Claude is still the best fit: free-tier models are weaker at following the trust rules and have tight rate limits. If the AI fails, Open Aisle now says why (retired model, bad key, too many requests) and logs a line starting `[open-aisle] AI provider error`.

Then: Settings → Connect PayPal → approve → Shop → "black running shoes, size 9, under 60 dollars" → "buy them" → Confirm → wait or say "cancel that".

**Merchant API:**

```bash
curl http://localhost:3000/api/v1/barriers?status=open -H "Authorization: Bearer oa_demo_northwind_sandbox_key"
```

Full description: [`apps/web/public/openapi.yaml`](apps/web/public/openapi.yaml) (served at `/openapi.yaml`). Generate SDKs: `npx @apimatic/cli sdk generate --language=typescript --input=apimatic`.

**MCP server** (lets another AI agent shop for Asha):

```json
{ "mcpServers": { "open-aisle": { "command": "pnpm", "args": ["--dir", "/path/to/open-aisle", "mcp"] } } }
```

## Tests and evals

```bash
pnpm test    # 64 tests: PayPal lifecycle, every way the trust layer must say no, the agent with a scripted model,
             # the Merchant API, the AG Studio ↔ Claude adapter, the OpenAPI file vs the real routes, MCP checkout
pnpm eval    # real-model evals (needs ANTHROPIC_API_KEY): trust traps, quality, Hindi → packages/core/evals/results.md
pnpm e2e     # 29 real-browser checks (with `pnpm demo` running; `pnpm db:seed` first for a clean run): axe on every page, first-visit choice, a full
             # simple-mode purchase with nothing stubbed, the full purchase with
             # keyboard checks, PayPal hold and undo, the fix board, the dashboard, an outside agent's confirm link
```

The trust tests include: paying with a made-up token, a cart changed after the read-back (including by an outside agent over MCP), a token used twice or expired, over-limit orders, limits edited in the database without re-signing, and a product description that tries to instruct the agent.

Accessibility: every page passes axe-core WCAG 2.2 AA checks with zero violations, including the read-back dialog, the fix board, the insights dashboard and the confirm page.

## Deploy on Render

`render.yaml` creates the web service and Postgres. Set the secrets in the dashboard, then seed once from the Render shell (`pnpm db:seed && pnpm demo:activity`). For durable captures, create a Render Workflows service from `apps/worker` (start `pnpm --filter @open-aisle/worker start`) and set `RENDER_API_KEY`; until then `INLINE_WORKER=true` lets the web app capture due orders itself.

## Project layout

```
apps/web        Next.js app: companion, read-back, orders, settings, confirm page, store pages, Merchant API (/api/v1)
apps/worker     Render Workflows tasks (captureAfterUndo, sweepDueOrders, draftBarrierFixes) + local runner
apps/mcp        Open Aisle as an MCP server for other AI agents
apps/e2e        Real-browser checks (Playwright + axe-core)
packages/core   Everything else: database, PayPal, fake PayPal, cart, trust layer, agent, barriers, merchant, studio, evals
apimatic        APIMatic project for the Merchant API SDKs
```

## Limits (honest)

- No real sign-in. Locally everyone is the demo shopper Asha; on the hosted demo (`DEMO_SESSIONS=per-visitor`) each browser gets its own copy of Asha, so visitors don't share a cart or limits. Store pages have no login.
- Voice input needs Chrome, Edge or Safari (Firefox can still hear replies and type).
- Demo products are original items with drawn images; real catalogs come from Channel3.
- PayPal's Store Sync and Agent Ready need an access request; our cart follows the shape of their cart operations.
- PayPal's approval page appears once when connecting; a helper can do this step.
- AG Studio and Bryntum run as trials (watermarked) in this repo.
