import type { Metadata } from "next";

export const metadata: Metadata = { title: "Merchant API" };

const ENDPOINTS: [string, string, string][] = [
  ["GET", "/store", "The store this key belongs to"],
  ["GET", "/orders", "Orders, newest first (filter with ?status=)"],
  ["GET", "/orders/{id}", "One order"],
  ["POST", "/orders/{id}/ship", "Send the tracking number to PayPal; the shopper hears it's on its way"],
  ["POST", "/orders/{id}/refund", "Refund through PayPal; the shopper hears it"],
  ["GET", "/barriers", "Missing information shoppers hit, most-hit first"],
  ["PATCH", "/barriers/{id}", "Move a barrier on the fix board"],
  ["POST", "/barriers/{id}/draft", "An AI-drafted fix to check"],
  ["POST", "/barriers/{id}/fix", "Write the information into the catalog"],
  ["GET", "/insights", "Sales kept, mistakes caught by the undo window, barriers fixed"],
];

export default function DevelopersPage() {
  return (
    <>
      <div className="page-intro">
        <h1>Merchant API</h1>
        <p>
          Your store's own systems can work with Open Aisle: ship and refund orders through PayPal, pull the barrier report into your product tools, and push fixes
          straight into the catalog. It's a plain JSON API with a key per store.
        </p>
        <p>
          The full description is an OpenAPI file: <a href="/openapi.yaml">openapi.yaml</a>. Typed SDKs (TypeScript, Python, Java, C#, PHP, Ruby, Go) are generated
          from it with APIMatic, the same tool that generates PayPal's own Server SDK that Open Aisle uses.
        </p>
      </div>

      <h2>Try it</h2>
      <p>The demo store Northwind Outfitters has a sandbox key. Every call needs it in the Authorization header.</p>
      <pre className="code-block" tabIndex={0} aria-label="Example request">
        <code>{`curl http://localhost:3000/api/v1/barriers?status=open \\
  -H "Authorization: Bearer oa_demo_northwind_sandbox_key"`}</code>
      </pre>

      <h2>Endpoints</h2>
      <p>All paths start with /api/v1.</p>
      <ul className="endpoint-list">
        {ENDPOINTS.map(([method, path, what]) => (
          <li key={method + path}>
            <span className="method">{method}</span> <code>{path}</code>: {what}
          </li>
        ))}
      </ul>

      <h2>Errors</h2>
      <p>Every answer has ok: true or ok: false. Errors carry a sentence a person can read and a code a program can check.</p>
      <pre className="code-block" tabIndex={0} aria-label="Example error">
        <code>{`{ "ok": false, "error": "Only paid orders can be refunded (this one is held).", "code": "conflict" }`}</code>
      </pre>

      <h2>What the API will never do</h2>
      <p>
        It can't place or charge orders. Only the shopper's own confirmation in Open Aisle can do that. A store can ship what was paid for and give money back, never
        take it.
      </p>
    </>
  );
}
