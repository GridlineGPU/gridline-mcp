import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createClient, DEFAULT_BASE_URL, type FetchLike } from "./client.ts";
import { createServer, SERVER_NAME } from "./server.ts";
import { TOOLS } from "./tools.ts";

const TOKEN = "glk_test_server_0123456789";

async function connected(fetch: FetchLike) {
  const server = createServer(createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, server };
}

describe("MCP server over the protocol", () => {
  test("lists every tool with a JSON input schema; spending tools expose confirm_spend", async () => {
    const { client } = await connected(async () => Response.json({}));
    expect(client.getServerVersion()?.name).toBe(SERVER_NAME);
    expect(client.getInstructions()).toContain("confirm_spend: true");
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      const spends = TOOLS.find((x) => x.name === t.name)?.spends === true;
      expect(Object.keys(t.inputSchema.properties ?? {}).includes("confirm_spend")).toBe(spends);
    }
    const ft = tools.find((t) => t.name === "create_fine_tune");
    expect(ft?.inputSchema.required).toEqual(["model", "training_file"]);
    expect(tools.find((t) => t.name === "get_batch")?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "create_batch")?.annotations?.readOnlyHint).toBe(false);
    await client.close();
  });

  test("a tool call reaches the API and returns its JSON; the key stays in the header", async () => {
    const seen: string[] = [];
    const { client } = await connected(async (url, init = {}) => {
      seen.push(url);
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
      return Response.json({ id: "batch_1", status: "completed" });
    });
    const result = await client.callTool({ name: "get_batch", arguments: { id: "batch_1" } });
    expect(seen).toEqual([`${DEFAULT_BASE_URL}/batches/batch_1`]);
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({ id: "batch_1", status: "completed" });
    expect(text).not.toContain(TOKEN);
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  test("the spend guard holds over the protocol", async () => {
    let requests = 0;
    const { client } = await connected(async () => {
      requests += 1;
      return Response.json({});
    });
    const result = await client.callTool({
      name: "create_batch",
      arguments: { input_file_id: "file-1" },
    });
    expect(result.isError).toBe(true);
    expect(requests).toBe(0);
    await client.close();
  });

  test("bad arguments are refused by the schema before any request", async () => {
    let requests = 0;
    const { client } = await connected(async () => {
      requests += 1;
      return Response.json({});
    });
    const result = await client
      .callTool({ name: "upload_file", arguments: { path: "/x.jsonl", purpose: "weights" } })
      .catch((error: unknown) => ({ isError: true, error }));
    expect(result.isError).toBe(true);
    expect(requests).toBe(0);
    await client.close();
  });
});

describe("gridline-mcp entry point", () => {
  test("without GRIDLINE_TOKEN it exits 2 with a plain message on stderr and nothing on stdout", async () => {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env))
      if (value !== undefined && key !== "GRIDLINE_TOKEN") env[key] = value;
    const child = Bun.spawn(["bun", new URL("./main.ts", import.meta.url).pathname], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("Set GRIDLINE_TOKEN");
  });
});
