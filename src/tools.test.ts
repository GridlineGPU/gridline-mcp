import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, DEFAULT_BASE_URL, type FetchLike } from "./client.ts";
import { callTool, needsConfirm, SPEND_GUARD_MESSAGE, TOOLS, type ToolDef } from "./tools.ts";

const TOKEN = "glk_test_tools_0123456789";
const dir = mkdtempSync(join(tmpdir(), "gridline-mcp-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Call = { method: string; url: string; body: unknown; form: FormData | null };

/** A mocked API: records every request and answers with `answer`'s JSON (or bytes). */
function api(answer: (call: Call) => unknown = () => ({ ok: true })) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const raw = init.body;
    const form = raw instanceof FormData ? raw : null;
    const body = typeof raw === "string" ? JSON.parse(raw) : null;
    const call = { method: init.method ?? "GET", url, body, form };
    calls.push(call);
    const value = answer(call);
    return value instanceof Uint8Array
      ? new Response(new Blob([value as Uint8Array<ArrayBuffer>]))
      : Response.json(value);
  };
  return { calls, client: createClient({ token: TOKEN, baseUrl: DEFAULT_BASE_URL, fetch }) };
}

const tool = (name: string): ToolDef => {
  const found = TOOLS.find((t) => t.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
};
const parse = (result: { content: ReadonlyArray<{ text: string }> }) =>
  JSON.parse(result.content[0]?.text ?? "null");
const path = (call: Call | undefined) => (call === undefined ? "" : new URL(call.url).pathname);

describe("tool catalogue", () => {
  test("unique names; every tool has a title, a description and a schema", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "list_models",
      "get_credit_balance",
      "upload_file",
      "create_fine_tune",
      "list_fine_tunes",
      "get_fine_tune",
      "list_fine_tune_events",
      "cancel_fine_tune",
      "create_batch",
      "get_batch",
      "cancel_batch",
      "download_results",
      "create_eval",
      "create_eval_run",
      "get_eval_run",
      "list_output_items",
      "request_merged_weights",
      "get_merged_weights",
      "get_merged_file_url",
    ]);
    for (const t of TOOLS) {
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(40);
      expect(typeof t.inputSchema).toBe("object");
    }
  });

  test("exactly the three spending tools carry the guard, and say what they cost", () => {
    const spending = TOOLS.filter((t) => t.spends).map((t) => t.name);
    expect(spending).toEqual(["create_fine_tune", "create_batch", "create_eval_run"]);
    for (const name of spending) {
      const t = tool(name);
      expect(t.description).toContain("Costs credit");
      expect(t.description).toContain("confirm_spend: true");
      expect(t.description).toContain("https://gridlinegpu.com/pricing");
      expect(Object.keys(t.inputSchema)).toContain("confirm_spend");
    }
    // Every other tool says it is free, or (create_eval) where the cost is.
    for (const t of TOOLS.filter((x) => !x.spends))
      expect(t.description).toMatch(/Free|free|no charge|runs cost credit/);
  });

  test("no price is typed into a description: costs point at the pricing page", () => {
    for (const t of TOOLS) expect(t.description).not.toMatch(/\$\s?\d/);
  });

  test("the package never writes to the console (stdout is the protocol)", () => {
    for (const file of ["client.ts", "tools.ts", "server.ts", "main.ts", "version.ts"]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text).not.toMatch(/console\.(log|info|warn|error|debug)/);
    }
  });
});

describe("spend guard", () => {
  test("a spending call without confirm_spend: true sends nothing and explains why", async () => {
    for (const [name, args] of [
      ["create_fine_tune", { model: "qwen2.5-7b-instruct", training_file: "file-1" }],
      ["create_fine_tune", { model: "m", training_file: "f", confirm_spend: false }],
      ["create_batch", { input_file_id: "file-2" }],
      ["create_eval_run", { eval_id: "eval_1", data_source: { type: "jsonl" } }],
    ] as const) {
      const { calls, client } = api();
      const result = await callTool(tool(name), client, { ...args });
      expect(result.isError).toBe(true);
      expect(parse(result)).toEqual({
        error: { code: "confirm_spend_required", message: SPEND_GUARD_MESSAGE },
      });
      expect(calls).toHaveLength(0);
    }
  });

  test("dry_run eval runs are quotes: no confirmation needed", () => {
    expect(needsConfirm(tool("create_eval_run"), { dry_run: true })).toBe(false);
    expect(needsConfirm(tool("create_eval_run"), { dry_run: false })).toBe(true);
    expect(needsConfirm(tool("list_models"), {})).toBe(false);
  });

  test("with confirm_spend: true the request is sent, without the guard flag", async () => {
    const { calls, client } = api(() => ({ id: "ftjob-1", object: "fine_tuning.job" }));
    const result = await callTool(tool("create_fine_tune"), client, {
      model: "qwen2.5-7b-instruct",
      training_file: "file-1",
      method: "qlora",
      hyperparameters: { n_epochs: 2 },
      confirm_spend: true,
    });
    expect(result.isError).toBeUndefined();
    expect(parse(result)).toEqual({ id: "ftjob-1", object: "fine_tuning.job" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(path(calls[0])).toBe("/openai/v1/fine_tuning/jobs");
    expect(calls[0]?.body).toEqual({
      model: "qwen2.5-7b-instruct",
      training_file: "file-1",
      method: "qlora",
      hyperparameters: { n_epochs: 2 },
    });
  });
});

describe("request shaping", () => {
  test("create_batch fills OpenAI's defaults and keeps what the caller set", async () => {
    const { calls, client } = api(() => ({ id: "batch_1" }));
    await callTool(tool("create_batch"), client, { input_file_id: "file-2", confirm_spend: true });
    expect(calls[0]?.body).toEqual({
      endpoint: "/v1/chat/completions",
      completion_window: "24h",
      input_file_id: "file-2",
    });
    await callTool(tool("create_batch"), client, {
      input_file_id: "file-3",
      endpoint: "/v1/embeddings",
      completion_window: "72h",
      confirm_spend: true,
    });
    expect(calls[1]?.body).toEqual({
      endpoint: "/v1/embeddings",
      completion_window: "72h",
      input_file_id: "file-3",
    });
  });

  test("create_eval_run posts to the eval's runs, dry_run passed through", async () => {
    const { calls, client } = api(() => ({ object: "eval.run.quote" }));
    await callTool(tool("create_eval_run"), client, {
      eval_id: "eval_1",
      data_source: { type: "completions", model: "ft:qwen" },
      dry_run: true,
    });
    expect(path(calls[0])).toBe("/openai/v1/evals/eval_1/runs");
    expect(calls[0]?.body).toEqual({
      data_source: { type: "completions", model: "ft:qwen" },
      dry_run: true,
    });
  });

  test("reads use GET with encoded ids and paging", async () => {
    const { calls, client } = api(() => ({ data: [] }));
    await callTool(tool("get_fine_tune"), client, { id: "ftjob-1" });
    await callTool(tool("list_fine_tune_events"), client, { id: "ftjob-1", limit: 10 });
    await callTool(tool("get_merged_weights"), client, { model: "ft:qwen2.5-7b:abc" });
    await callTool(tool("list_output_items"), client, { eval_id: "e", run_id: "r", after: "x" });
    expect(
      calls.map((c) => `${c.method} ${new URL(c.url).pathname}${new URL(c.url).search}`),
    ).toEqual([
      "GET /openai/v1/fine_tuning/jobs/ftjob-1",
      "GET /openai/v1/fine_tuning/jobs/ftjob-1/events?limit=10",
      "GET /openai/v1/gridline/adapters/ft%3Aqwen2.5-7b%3Aabc/merged",
      "GET /openai/v1/evals/e/runs/r/output_items?after=x",
    ]);
  });

  test("a dot-segment id is refused before any request", async () => {
    const { calls, client } = api();
    const result = await callTool(tool("get_batch"), client, { id: ".." });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("upload_file sends multipart with purpose and the file's bytes and name", async () => {
    const file = join(dir, "train.jsonl");
    writeFileSync(file, '{"messages":[]}\n');
    const { calls, client } = api(() => ({ id: "file-9", object: "file" }));
    const result = await callTool(tool("upload_file"), client, {
      path: file,
      purpose: "fine-tune",
    });
    expect(parse(result)).toEqual({ id: "file-9", object: "file" });
    expect(path(calls[0])).toBe("/openai/v1/files");
    const form = calls[0]?.form as FormData;
    expect(form.get("purpose")).toBe("fine-tune");
    const sent = form.get("file") as File;
    expect(sent.name).toBe("train.jsonl");
    expect(await sent.text()).toBe('{"messages":[]}\n');
  });

  test("a missing local file is a clear error, not a request", async () => {
    const { calls, client } = api();
    const result = await callTool(tool("upload_file"), client, {
      path: join(dir, "nope.jsonl"),
      purpose: "batch",
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("download_results finds the batch's output file and writes it locally", async () => {
    const bytes = new TextEncoder().encode('{"id":"r1"}\n');
    const { calls, client } = api((call) =>
      new URL(call.url).pathname.endsWith("/content")
        ? bytes
        : { id: "batch_1", status: "completed", output_file_id: "file-out" },
    );
    const out = join(dir, "out.jsonl");
    const result = await callTool(tool("download_results"), client, {
      batch_id: "batch_1",
      output_path: out,
    });
    expect(parse(result)).toEqual({ file_id: "file-out", path: out, bytes: bytes.byteLength });
    expect(readFileSync(out, "utf8")).toBe('{"id":"r1"}\n');
    expect(calls.map((c) => path(c))).toEqual([
      "/openai/v1/batches/batch_1",
      "/openai/v1/files/file-out/content",
    ]);
  });

  test("download_results before the batch has output says so", async () => {
    const { client } = api(() => ({ id: "batch_1", status: "in_progress", output_file_id: null }));
    const result = await callTool(tool("download_results"), client, {
      batch_id: "batch_1",
      output_path: join(dir, "x.jsonl"),
    });
    expect(result.isError).toBe(true);
    expect(parse(result).error.message).toBe(
      "The batch has no output_file_id yet (status: in_progress).",
    );
  });

  test("get_credit_balance returns Gridline's balance block and recent lines", async () => {
    const { calls, client } = api(() => ({
      object: "list",
      data: [{ id: "batch_1" }],
      gridline: { balance_usd: "4.50", low_credit: false },
    }));
    const result = await callTool(tool("get_credit_balance"), client, {});
    expect(parse(result)).toEqual({
      balance: { balance_usd: "4.50", low_credit: false },
      recent: [{ id: "batch_1" }],
    });
    expect(new URL(calls[0]?.url ?? "").search).toBe("?limit=5");
  });

  test("no result ever contains the key", async () => {
    const { client } = api((call) => ({ echoed_url: call.url }));
    for (const t of TOOLS.filter((x) => x.readOnly && x.name !== "get_merged_file_url")) {
      const args: Record<string, unknown> = { id: "a", eval_id: "e", run_id: "r", model: "m" };
      const result = await callTool(t, client, args);
      expect(result.content[0]?.text).not.toContain(TOKEN);
    }
  });
});
