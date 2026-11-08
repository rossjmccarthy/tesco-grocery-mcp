#!/usr/bin/env node

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadCredentialsFromEnv, STORE } from "./client.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerSearchTools } from "./tools/search.js";
import { registerBasketTools } from "./tools/basket.js";
import { registerBrowseTools } from "./tools/browse.js";
import { registerSlotTools } from "./tools/slots.js";

function loadVersion(): string {
  const require = createRequire(import.meta.url);
  // dist/src/index.js → ../../package.json; src/index.ts → ../package.json
  try { return (require("../../package.json") as { version: string }).version; }
  catch { return (require("../package.json") as { version: string }).version; }
}

// Load credentials from .env (non-fatal if missing)
loadCredentialsFromEnv();

// Create MCP server
// Sent to every client as the server's instructions: hub clients do not see
// skills/SKILL.md, so the rules that keep a shop safe live here.
const INSTRUCTIONS = [
  `Tesco grocery shopping (${STORE.region}, prices in ${STORE.currency}).`,
  'Before planning a shop or filling the basket from recipes, read the DocMost page "Tesco Shopping Preferences" if DocMost tools are available (staples, brands, aliases, things to avoid, household size) and follow it.',
  "Batch product lookups in one search_products call. Before adding a recipe's items, call add_to_basket with dryRun: true and show the preview; then apply it.",
  'Use mode "add" (the default) so several recipes combine; never lower an existing quantity, or remove items, without asking.',
  "undo_last_basket_change reverses the last basket change. Never book or unbook a delivery slot without asking. There is no checkout: the person places the order on the Tesco website.",
].join(" ");

const server = new McpServer(
  { name: "tesco-grocery", version: loadVersion() },
  { instructions: INSTRUCTIONS },
);

// Register all tools
registerAuthTools(server);
registerSearchTools(server);
registerBasketTools(server);
registerBrowseTools(server);
registerSlotTools(server);

// Connect via stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[tesco] MCP server running on stdio");
