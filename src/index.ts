#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { parseConfig } from "./config.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = parseConfig();
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Servarr Analytics MCP running on stdio");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`Fatal error in servarr-analytics-mcp:\n${message}`);
  process.exit(1);
});
