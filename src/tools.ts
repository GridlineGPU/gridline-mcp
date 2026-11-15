import { readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { z } from "zod";
import { GridlineApiError, type GridlineClient, seg } from "./client.ts";

/**
 * The MCP tools: thin, typed wrappers over Gridline's public, OpenAI-compatible API. Each tool's
 * description says what it costs, so an agent can plan spend before it acts. Three tools spend
 * credit (create_fine_tune, create_batch, create_eval_run without dry_run); they refuse unless the
 * call carries `confirm_spend: true`, which an agent should send only after it has read the quote or
 * the model's price. The guard runs before any request, so a refused call sends nothing.
 */

export type ToolResult = Readonly<{
  content: ReadonlyArray<{ type: "text"; text: string }>;
  isError?: boolean;
}>;

export type ToolDef = Readonly<{
  name: string;
  title: string;
  description: string;
  /** Spends credit: refused without confirm_spend: true (create_eval_run: unless dry_run). */
  spends: boolean;
  /** Read-only: changes nothing on the account. */
  readOnly: boolean;
  inputSchema: z.ZodRawShape;
  run: (client: GridlineClient, args: Record<string, unknown>) => Promise<unknown>;
}>;

export const PRICING_URL = "https://gridlinegpu.com/pricing";

const COST_FINE_TUNE = `Costs credit: a fine-tune is charged per 1M trained tokens (training tokens × epochs) at the base model's published fine-tuning price, with the per-job minimum (${PRICING_URL}). When the job starts, its maximum possible cost is held from your credit and the unused part is returned when it ends; a job your credit cannot cover does not start (insufficient_quota). The created job object carries Gridline's quote (an upper bound). Jobs stopped by a platform fault or the time limit are not charged.`;
const COST_BATCH = `Costs credit: a batch is charged per 1M input and output tokens at the model's published batch price, and at least the model's per-batch minimum (${PRICING_URL}). A batch whose upper bound your credit cannot cover is refused before it runs.`;
const COST_EVAL_RUN = `Costs credit unless dry_run is true: an eval run is billed as ordinary batches at published batch prices, each at least its model's per-batch minimum (${PRICING_URL}). A run that only uses string_check and text_similarity on a file's own answers creates no batch and costs nothing. Send dry_run: true first to get the quote.`;
const FREE = "Free: no charge.";

export const SPEND_GUARD_MESSAGE =
  "This call spends credit, so it needs confirm_spend: true. Read the quote first (create_eval_run with dry_run: true, the model's price from list_models or " +
  `${PRICING_URL}), then call again with confirm_spend: true.`;

const id = (what: string) => z.string().min(1).max(200).describe(what);
const pageArgs = {
  after: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Cursor: the last id of the previous page."),
  limit: z.number().int().min(1).max(100).optional().describe("Page size, 1 to 100."),
};
const confirmSpend = z
  .boolean()
  .optional()
  .describe(
    "Must be true for this call to run: you have read the quote or price and accept the charge.",
  );

/** Drop undefined keys and the guard flag before a request body is sent. */
function body(
  args: Record<string, unknown>,
  omit: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args))
    if (value !== undefined && key !== "confirm_spend" && !omit.includes(key)) out[key] = value;
  return out;
}

const str = (value: unknown): string => String(value);

const TOOL_LIST: ToolDef[] = [
  {
    name: "list_models",
    title: "List models",
    description: `List the base models you can batch or fine-tune on, and your own ft: models. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: {},
    run: (client) => client.get("/models"),
  },
  {
    name: "get_credit_balance",
    title: "Credit balance",
    description: `Your credit balance and low-credit threshold (Gridline's usage summary), plus your most recent charges. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { limit: pageArgs.limit },
    run: async (client, args) => {
      const answer = (await client.get("/gridline/usage", {
        limit: (args.limit as number | undefined) ?? 5,
      })) as Record<string, unknown>;
      return { balance: answer.gridline ?? null, recent: answer.data ?? [] };
    },
  },
  {
    name: "upload_file",
    title: "Upload a file",
    description: `Upload a local JSONL file to the Files API. purpose "fine-tune" for training/validation data (OpenAI chat format; DPO preference rows for DPO), "batch" for a batch input file (one request per line). At most 200 MB. Returns the file object; use its id in create_fine_tune, create_batch or an eval run. ${FREE} Stored files count toward your storage limits.`,
    spends: false,
    readOnly: false,
    inputSchema: {
      path: z.string().min(1).describe("Local path of the JSONL file to upload."),
      purpose: z.enum(["fine-tune", "batch"]).describe('"fine-tune" or "batch".'),
    },
    run: async (client, args) => {
      const path = resolve(str(args.path));
      const bytes = await readFile(path);
      const form = new FormData();
      form.set("purpose", str(args.purpose));
      form.set("file", new Blob([bytes], { type: "application/jsonl" }), basename(path));
      return client.postForm("/files", form);
    },
  },
  {
    name: "create_fine_tune",
    title: "Create a fine-tuning job",
    description: `Start a fine-tuning job (OpenAI's /fine_tuning/jobs shape) that trains a LoRA or QLoRA adapter on an open base model and names the result with an ft: id. method: "lora" or "qlora" as a string, or OpenAI's {"type": "supervised", "supervised": {"adapter": "lora", "hyperparameters": {...}}} or {"type": "dpo", "dpo": {"hyperparameters": {"beta": ...}}}. Hyperparameters (n_epochs, batch_size, learning_rate_multiplier, lora_rank, lora_alpha, max_seq_length) go in hyperparameters or inside method, once. ${COST_FINE_TUNE} Requires confirm_spend: true.`,
    spends: true,
    readOnly: false,
    inputSchema: {
      model: z
        .string()
        .min(1)
        .describe("Base model id, e.g. qwen2.5-7b-instruct (see list_models)."),
      training_file: id("File id of the training data (purpose fine-tune)."),
      validation_file: id("Optional validation file id.").optional(),
      method: z
        .union([z.enum(["lora", "qlora"]), z.record(z.string(), z.unknown())])
        .optional()
        .describe('"lora", "qlora", or an OpenAI method object (supervised or dpo).'),
      hyperparameters: z.record(z.string(), z.unknown()).optional().describe("Training settings."),
      suffix: z.string().max(64).optional().describe("A short label in the ft: model name."),
      seed: z.number().int().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
      confirm_spend: confirmSpend,
    },
    run: (client, args) => client.post("/fine_tuning/jobs", body(args)),
  },
  {
    name: "list_fine_tunes",
    title: "List fine-tuning jobs",
    description: `List your fine-tuning jobs, newest first. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { ...pageArgs },
    run: (client, args) =>
      client.get("/fine_tuning/jobs", {
        after: args.after as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "get_fine_tune",
    title: "Get a fine-tuning job",
    description: `A fine-tuning job's status, its quote and, once it succeeds, its ft: model. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { id: id("Fine-tuning job id (ftjob-...).") },
    run: (client, args) => client.get(`/fine_tuning/jobs/${seg(str(args.id))}`),
  },
  {
    name: "list_fine_tune_events",
    title: "Fine-tuning job events",
    description: `A fine-tuning job's events: progress, training and validation loss, warnings and errors. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { id: id("Fine-tuning job id."), ...pageArgs },
    run: (client, args) =>
      client.get(`/fine_tuning/jobs/${seg(str(args.id))}/events`, {
        after: args.after as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "cancel_fine_tune",
    title: "Cancel a fine-tuning job",
    description: `Cancel a fine-tuning job. It stops the job; read the job afterwards (get_fine_tune) for its final state and charge. ${FREE}`,
    spends: false,
    readOnly: false,
    inputSchema: { id: id("Fine-tuning job id.") },
    run: (client, args) => client.post(`/fine_tuning/jobs/${seg(str(args.id))}/cancel`),
  },
  {
    name: "create_batch",
    title: "Create a batch",
    description: `Run a batch (OpenAI's /batches shape) over an uploaded batch file on a base model or your ft: model. endpoint: "/v1/chat/completions" (default) or "/v1/embeddings". completion_window: "24h" (default) or Gridline's looser "72h". ${COST_BATCH} Requires confirm_spend: true.`,
    spends: true,
    readOnly: false,
    inputSchema: {
      input_file_id: id("File id of the batch input (purpose batch)."),
      endpoint: z
        .enum(["/v1/chat/completions", "/v1/embeddings"])
        .optional()
        .describe('Default "/v1/chat/completions".'),
      completion_window: z.enum(["24h", "72h"]).optional().describe('Default "24h".'),
      metadata: z.record(z.string(), z.string()).optional(),
      confirm_spend: confirmSpend,
    },
    run: (client, args) =>
      client.post("/batches", {
        endpoint: "/v1/chat/completions",
        completion_window: "24h",
        ...body(args),
      }),
  },
  {
    name: "get_batch",
    title: "Get a batch",
    description: `A batch's status, request counts, cost and its output/error file ids. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { id: id("Batch id (batch_...).") },
    run: (client, args) => client.get(`/batches/${seg(str(args.id))}`),
  },
  {
    name: "cancel_batch",
    title: "Cancel a batch",
    description: `Cancel a batch. A cancelled batch still delivers, and charges for, the requests that completed; the rest are not run. ${FREE}`,
    spends: false,
    readOnly: false,
    inputSchema: { id: id("Batch id.") },
    run: (client, args) => client.post(`/batches/${seg(str(args.id))}/cancel`),
  },
  {
    name: "download_results",
    title: "Download batch results",
    description: `Save a batch's output (or error) file to a local path. Give batch_id (which: "output" or "error") or a file_id. ${FREE}`,
    spends: false,
    readOnly: false,
    inputSchema: {
      batch_id: id("Batch id.").optional(),
      file_id: id("A file id to download instead of a batch's.").optional(),
      which: z.enum(["output", "error"]).optional().describe('Default "output".'),
      output_path: z.string().min(1).describe("Local path to write the JSONL to."),
    },
    run: async (client, args) => {
      let fileId = args.file_id === undefined ? null : str(args.file_id);
      if (fileId === null) {
        if (args.batch_id === undefined)
          throw new GridlineApiError("Give batch_id or file_id.", 400, { param: "batch_id" });
        const batch = (await client.get(`/batches/${seg(str(args.batch_id))}`)) as Record<
          string,
          unknown
        >;
        const key = args.which === "error" ? "error_file_id" : "output_file_id";
        const value = batch[key];
        if (typeof value !== "string" || value === "")
          throw new GridlineApiError(
            `The batch has no ${key} yet (status: ${String(batch.status)}).`,
            409,
            { param: "batch_id" },
          );
        fileId = value;
      }
      const bytes = await client.getBytes(`/files/${seg(fileId)}/content`);
      const path = resolve(str(args.output_path));
      await writeFile(path, bytes);
      return { file_id: fileId, path, bytes: bytes.byteLength };
    },
  },
  {
    name: "create_eval",
    title: "Create an eval",
    description: `Define an eval (OpenAI's Evals API): data_source_config (the item schema) and testing_criteria (graders: string_check, text_similarity, score_model). Defining it is free; runs cost credit (see create_eval_run).`,
    spends: false,
    readOnly: false,
    inputSchema: {
      name: z.string().min(1).max(200).optional(),
      data_source_config: z.record(z.string(), z.unknown()).describe("OpenAI data_source_config."),
      testing_criteria: z
        .array(z.record(z.string(), z.unknown()))
        .min(1)
        .describe("Graders, OpenAI's shape."),
      metadata: z.record(z.string(), z.string()).optional(),
    },
    run: (client, args) => client.post("/evals", body(args)),
  },
  {
    name: "create_eval_run",
    title: "Run an eval",
    description: `Run an eval over a data source: a file of items, or completions sampled from a model (a base model or your ft: model, to compare them). ${COST_EVAL_RUN} Requires confirm_spend: true unless dry_run is true.`,
    spends: true,
    readOnly: false,
    inputSchema: {
      eval_id: id("Eval id (eval_...)."),
      name: z.string().min(1).max(200).optional(),
      data_source: z.record(z.string(), z.unknown()).describe("OpenAI eval run data_source."),
      dry_run: z.boolean().optional().describe("true: return the quote only; nothing runs."),
      metadata: z.record(z.string(), z.string()).optional(),
      confirm_spend: confirmSpend,
    },
    run: (client, args) =>
      client.post(`/evals/${seg(str(args.eval_id))}/runs`, body(args, ["eval_id"])),
  },
  {
    name: "get_eval_run",
    title: "Get an eval run",
    description: `An eval run's status, per-grader results, cost and its results file. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { eval_id: id("Eval id."), run_id: id("Run id (evalrun_...).") },
    run: (client, args) =>
      client.get(`/evals/${seg(str(args.eval_id))}/runs/${seg(str(args.run_id))}`),
  },
  {
    name: "list_output_items",
    title: "Eval run output items",
    description: `An eval run's graded items: each sample and every grader's result. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { eval_id: id("Eval id."), run_id: id("Run id."), ...pageArgs },
    run: (client, args) =>
      client.get(`/evals/${seg(str(args.eval_id))}/runs/${seg(str(args.run_id))}/output_items`, {
        after: args.after as string | undefined,
        limit: args.limit as number | undefined,
      }),
  },
  {
    name: "request_merged_weights",
    title: "Export merged weights",
    description:
      "Ask for an ft: model merged into its base as full safetensors. Free: the merge and download are at no charge; the export is kept 7 days. Poll get_merged_weights until it succeeds.",
    spends: false,
    readOnly: false,
    inputSchema: { model: id("Your ft: model id.") },
    run: (client, args) => client.post(`/gridline/adapters/${seg(str(args.model))}/merged`),
  },
  {
    name: "get_merged_weights",
    title: "Merged weights status",
    description: `A merged-weights export's status and its file list. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: { model: id("Your ft: model id.") },
    run: (client, args) => client.get(`/gridline/adapters/${seg(str(args.model))}/merged`),
  },
  {
    name: "get_merged_file_url",
    title: "Merged weights download URL",
    description: `A short-lived (15 minute) download URL for one file of a merged-weights export. Download it with any HTTP client; the bytes are not passed through this tool. ${FREE}`,
    spends: false,
    readOnly: true,
    inputSchema: {
      model: id("Your ft: model id."),
      path: z.string().min(1).max(500).describe("File path from get_merged_weights."),
    },
    run: (client, args) =>
      client.get(`/gridline/adapters/${seg(str(args.model))}/merged/files/${seg(str(args.path))}`),
  },
];

export const TOOLS: readonly ToolDef[] = Object.freeze(TOOL_LIST);

/** Whether a call to this tool must carry confirm_spend: true. */
export function needsConfirm(tool: ToolDef, args: Record<string, unknown>): boolean {
  if (!tool.spends) return false;
  if (tool.name === "create_eval_run" && args.dry_run === true) return false;
  return args.confirm_spend !== true;
}

const text = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
});

/** Run one tool: the spend guard first, then the request; API refusals come back as error results. */
export async function callTool(
  tool: ToolDef,
  client: GridlineClient,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (needsConfirm(tool, args))
    return {
      ...text({ error: { code: "confirm_spend_required", message: SPEND_GUARD_MESSAGE } }),
      isError: true,
    };
  try {
    return text(await tool.run(client, args));
  } catch (error) {
    if (error instanceof GridlineApiError) return { ...text(error.toJSON()), isError: true };
    const message = error instanceof Error ? error.message : String(error);
    return { ...text({ error: { message, status: null } }), isError: true };
  }
}
