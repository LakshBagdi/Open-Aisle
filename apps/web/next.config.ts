import type { NextConfig } from "next";
import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

// One .env at the repository root is enough (apps/web/.env still works and wins).
loadEnv({ path: resolve(process.cwd(), "../../.env"), quiet: true });

const config: NextConfig = {
  // Our shared package is TypeScript source; Next compiles it with the app.
  transpilePackages: ["@open-aisle/core"],
  // These run only on the server and work best loaded straight from node_modules.
  serverExternalPackages: ["@paypal/paypal-server-sdk", "axios", "postgres"],
  poweredByHeader: false,
  // Don't write an AGENTS.md into the repo when `next dev` starts.
  agentRules: false,
};

export default config;
