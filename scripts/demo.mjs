#!/usr/bin/env node
/**
 * One command to try Open Aisle:  pnpm demo
 *
 *  1. creates .env from .env.example if there isn't one
 *  2. sets up the database (migrations + demo stores) the first time
 *  3. starts the fake PayPal (unless real PayPal keys are set) and the app
 *
 * Then open http://localhost:3000. Ctrl+C stops everything.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
if (!existsSync(envFile)) {
  copyFileSync(join(root, ".env.example"), envFile);
  console.log("Created .env from .env.example (fake PayPal, no AI key: simple mode).");
}
const env = Object.fromEntries(
  readFileSync(envFile, "utf8")
    .split("\n")
    .filter((l) => /^\s*[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const useFake = Boolean(env.PAYPAL_API_BASE) || !env.PAYPAL_CLIENT_ID;

const run = (args, opts = {}) => spawnSync("pnpm", args, { cwd: root, stdio: "inherit", ...opts });
console.log("\nSetting up the database…");
if (run(["db:migrate"]).status !== 0) {
  console.error("\nCouldn't reach the database. Is PostgreSQL running, and is DATABASE_URL in .env right?");
  process.exit(1);
}
run(["db:seed"]);

const children = [];
const start = (name, args, extraEnv = {}) => {
  // detached = its own process group, so Ctrl+C can stop everything it started.
  const child = spawn("pnpm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv }, detached: true });
  const tag = (data) => data.toString().split("\n").filter(Boolean).forEach((line) => console.log(`[${name}] ${line}`));
  child.stdout.on("data", tag);
  child.stderr.on("data", tag);
  children.push(child);
};
if (useFake) start("paypal", ["fake-paypal"]);
start("app", ["dev"], { INLINE_WORKER: "true" });

const port = process.env.PORT ?? "3000";
console.log(`\nStarting${useFake ? " the fake PayPal and" : ""} the app (the first page takes a few seconds to compile).`);
console.log(`Open http://localhost:${port} in Chrome or Edge. Press Ctrl+C to stop.\n`);
const stop = () => {
  for (const c of children) {
    try {
      process.kill(-c.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
  }
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
