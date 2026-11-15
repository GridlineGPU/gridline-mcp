import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GridlineClient } from "./client.ts";
import { callTool, TOOLS } from "./tools.ts";
import { MCP_VERSION } from "./version.ts";

export { configFromEnv, createClient, DEFAULT_BASE_URL, TOKEN_ENV } from "./client.ts";
export { needsConfirm, SPEND_GUARD_MESSAGE, TOOLS } from "./tools.ts";

export const SERVER_NAME = "gridline";
export const SERVER_VERSION = MCP_VERSION;

const INSTRUCTIONS =
  "Gridline: managed fine-tuning, evals and batch inference on open models through an OpenAI-compatible API. " +
  "A typical loop: upload_file (training data) → create_fine_tune → poll get_fine_tune → create_eval + create_eval_run (dry_run first) comparing the base and the ft: model → create_batch on the ft: model → download_results. " +
  "Tools that spend credit (create_fine_tune, create_batch, create_eval_run) need confirm_spend: true; check the quote or the price first and tell the user what it will cost.";

/** The MCP server with every Gridline tool registered over one API client. */
export function createServer(client: GridlineClient): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  for (const tool of TOOLS)
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          title: tool.title,
          readOnlyHint: tool.readOnly,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      async (args: Record<string, unknown>) => {
        const result = await callTool(tool, client, args ?? {});
        return { content: [...result.content], ...(result.isError ? { isError: true } : {}) };
      },
    );
  return server;
}
