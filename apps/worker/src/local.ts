/**
 * Local stand-in for Render Workflows: every 5 seconds, charge any held
 * order whose undo window has ended.   pnpm dev:worker
 *
 * (Or set INLINE_WORKER=true and the web app does this itself.)
 */
import "dotenv/config";
import { closeDb } from "@open-aisle/core";
import { captureDueOrders } from "@open-aisle/core/orders";

let stopping = false;

async function loop() {
  console.log("Open Aisle local worker: checking for orders to charge every 5 seconds.");
  while (!stopping) {
    try {
      const { captured, failed } = await captureDueOrders();
      if (captured.length) console.log(`Charged: ${captured.join(", ")}`);
      if (failed.length) console.warn(`Will retry: ${failed.join(", ")}`);
    } catch (err) {
      console.error("Sweep failed, retrying:", err);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  await closeDb();
}

process.on("SIGINT", () => (stopping = true));
process.on("SIGTERM", () => (stopping = true));
void loop();
