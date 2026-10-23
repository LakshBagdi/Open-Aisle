/**
 * Run Open Aisle as an MCP server over stdio.
 *
 *   pnpm mcp
 *
 * Add it to an MCP client (e.g. Claude Desktop) with:
 *   { "command": "pnpm", "args": ["--dir", "/path/to/open-aisle", "mcp"] }
 *
 * Environment: the same .env as the app. OPEN_AISLE_USER_ID picks the shopper
 * (defaults to the demo shopper Asha); APP_URL is where confirm links point.
 */
import "dotenv/config";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { defaultModel } from "@open-aisle/core/agent";
import { aiEnabled, env } from "@open-aisle/core";
import { createOpenAisleMcp } from "./shop";

const DEMO_USER_ID = "00000000-0000-4000-8000-00000000a5a0";

const server = createOpenAisleMcp({
  userId: process.env.OPEN_AISLE_USER_ID || DEMO_USER_ID,
  appUrl: env().APP_URL,
  model: aiEnabled() ? defaultModel() : undefined,
});

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error("Open Aisle MCP server ready (stdio).");
