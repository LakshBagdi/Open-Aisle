import type { NextConfig } from "next";

const config: NextConfig = {
  // Our shared package is TypeScript source; Next compiles it with the app.
  transpilePackages: ["@open-aisle/core"],
  // These run only on the server and work best loaded straight from node_modules.
  serverExternalPackages: ["@paypal/paypal-server-sdk", "axios", "postgres"],
  poweredByHeader: false,
};

export default config;
