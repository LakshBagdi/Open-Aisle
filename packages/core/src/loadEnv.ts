/**
 * Load settings from `.env` files: the current folder's first, then the one
 * at the repository root. So one `.env` at the root is enough for every part
 * (web app, scripts, worker, MCP server, tests). Values already set in the
 * environment (e.g. on Render) always win.
 */
import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
for (const file of new Set([join(process.cwd(), ".env"), join(root, ".env")])) {
  if (existsSync(file)) config({ path: file, quiet: true });
}
