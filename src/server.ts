import { McpServer } from "@modelcontextprotocol/server";
import { createTools } from "./tools.js";
import { toolResponse } from "./response.js";
import type { RuntimeConfig } from "./types.js";

export function buildServer(config: RuntimeConfig): McpServer {
  const server = new McpServer({
    name: "servarr-analytics-mcp",
    version: "0.1.0"
  });

  for (const tool of createTools()) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema
      },
      async (args: any) => toolResponse(await tool.handler(args, { config }))
    );
  }

  return server;
}
