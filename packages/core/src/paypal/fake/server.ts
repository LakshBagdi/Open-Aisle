/**
 * Run the fake PayPal on its own:  pnpm fake-paypal
 * Then set PAYPAL_API_BASE=http://127.0.0.1:4010 in .env.
 */
import "dotenv/config";
import { createFakePayPal } from "./fakePayPal";

const port = Number(process.env.FAKE_PAYPAL_PORT ?? 4010);
const appUrl = process.env.APP_URL ?? "http://localhost:3000";

const fake = createFakePayPal({
  port,
  webhookUrl: `${appUrl}/api/paypal/webhook`,
  webhookId: process.env.PAYPAL_WEBHOOK_ID || "FAKE-WEBHOOK-ID",
  webhookDelayMs: 300,
  log: true,
});

fake.start().then((url) => {
  console.log(`Fake PayPal listening on ${url}`);
  console.log(`Webhooks go to ${appUrl}/api/paypal/webhook`);
});
