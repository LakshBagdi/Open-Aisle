import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://openaisle:openaisle@localhost:5432/openaisle_test",
      CONFIRM_TOKEN_SECRET: "test-secret-that-is-long-enough-123456",
      PAYPAL_WEBHOOK_ID: "TEST-WEBHOOK-ID",
      ANTHROPIC_API_KEY: "",
    },
  },
});
