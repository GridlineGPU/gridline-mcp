#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createClient } from "./client.ts";
import { createServer } from "./server.ts";

/**
 * `gridline-mcp`: the Gridline MCP server over stdio. Configure an MCP client to run it with
 * GRIDLINE_TOKEN set to a Gridline API key (and optionally GRIDLINE_BASE_URL). stdout carries the
 * protocol only; the one message this file writes goes to stderr and never contains the key.
 */
async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  if ("error" in config) {
    process.stderr.write(`gridline-mcp: ${config.error}\n`);
    process.exit(2);
  }
  const server = createServer(createClient(config));
  await server.connect(new StdioServerTransport());
}

await main();
