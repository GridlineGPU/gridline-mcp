# @gridlinegpu/mcp

Gridline's MCP server. It lets an AI agent (Claude Code, Claude Desktop or any other MCP client)
fine-tune, evaluate and batch open models through Gridline's OpenAI-compatible API, with no GPUs,
containers or sandboxes to manage.

- Docs: <https://gridlinegpu.com/docs/agents>
- Pricing: <https://gridlinegpu.com/pricing>
- API base URL: `https://api.gridlinegpu.com/openai/v1`

## Install

You need Node.js 18 or later and a Gridline API key (create one in the dashboard at
<https://gridlinegpu.com/dashboard>). The server runs over stdio:

```sh
npx -y @gridlinegpu/mcp
```

### Claude Code

```sh
claude mcp add gridline --scope user --env GRIDLINE_TOKEN=$GRIDLINE_TOKEN -- npx -y @gridlinegpu/mcp
```

`--scope user` makes the server available in every project; leave it out to add it to the current
project only. Check it with `claude mcp list`, or `/mcp` inside Claude Code.

### Cursor

Add the server to `~/.cursor/mcp.json` (every project) or `.cursor/mcp.json` in a project's root
(that project only), then enable it under Cursor Settings → MCP:

```json
{
  "mcpServers": {
    "gridline": {
      "command": "npx",
      "args": ["-y", "@gridlinegpu/mcp"],
      "env": { "GRIDLINE_TOKEN": "<your Gridline API key>" }
    }
  }
}
```

### Claude Desktop

Open Settings → Developer → Edit Config, which opens `claude_desktop_config.json`
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows). Add the server under `mcpServers`, save,
and restart Claude Desktop:

```json
{
  "mcpServers": {
    "gridline": {
      "command": "npx",
      "args": ["-y", "@gridlinegpu/mcp"],
      "env": { "GRIDLINE_TOKEN": "<your Gridline API key>" }
    }
  }
}
```

Claude Desktop starts `npx` itself, so Node.js 18 or later has to be installed where it can find it.

### Any other MCP client with a JSON config

The same block works in any client that reads an `mcpServers` config:

```json
{
  "mcpServers": {
    "gridline": {
      "command": "npx",
      "args": ["-y", "@gridlinegpu/mcp"],
      "env": { "GRIDLINE_TOKEN": "<your Gridline API key>" }
    }
  }
}
```

Its name in the official MCP Registry is `io.github.GridlineGPU/mcp` (see `server.json` in this
folder).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `GRIDLINE_TOKEN` | yes | Your Gridline API key. Sent only as the `Authorization: Bearer` header to Gridline's API; never printed and never returned in a tool result. |
| `GRIDLINE_BASE_URL` | no | Overrides the API base URL. Must be https. |

## Spending credit: `confirm_spend`

Three tools spend credit: `create_fine_tune`, `create_batch` and `create_eval_run` (unless
`dry_run` is true). Each refuses, and sends nothing, unless the call carries
`confirm_spend: true`. An agent has to read the quote or the price first, so it cannot spend by
accident; tell your agent to report the cost before it confirms. Every other tool is free. Fine-tunes
are charged per training token and batches per input and output token, each with its minimum: see
<https://gridlinegpu.com/pricing>.

## Tools

| Tool | Spends credit | What it does |
| --- | --- | --- |
| `list_models` | no | Base models you can batch or fine-tune on, and your `ft:` models. |
| `get_credit_balance` | no | Your credit balance and recent charges. |
| `upload_file` | no | Upload a local JSONL file (purpose `fine-tune` or `batch`). |
| `create_fine_tune` | yes | Start a LoRA, QLoRA or DPO fine-tuning job. |
| `list_fine_tunes` | no | Your fine-tuning jobs. |
| `get_fine_tune` | no | A job's status, its quote and its `ft:` model once it succeeds. |
| `list_fine_tune_events` | no | A job's progress and loss. |
| `cancel_fine_tune` | no | Cancel a fine-tuning job. |
| `create_batch` | yes | Run a batch on a base model or your `ft:` model. |
| `get_batch` | no | A batch's status, counts and output file ids. |
| `cancel_batch` | no | Cancel a batch. |
| `download_results` | no | Save a batch's output or error file to a local path. |
| `create_eval` | no | Define an eval: its item schema and graders. |
| `create_eval_run` | yes | Run an eval, or quote it with `dry_run`. |
| `get_eval_run` | no | A run's status and per-grader results. |
| `list_output_items` | no | A run's graded rows. |
| `request_merged_weights` | no | Export an `ft:` model merged into its base. |
| `get_merged_weights` | no | A merged-weights export's status and files. |
| `get_merged_file_url` | no | A short-lived download URL for one merged file. |

## A worked loop

Ask your agent, for example: "Fine-tune qwen2.5-7b-instruct on ./train.jsonl, compare it with the
base on ./eval.jsonl, and run ./requests.jsonl as a batch on whichever scores higher. Tell me what
each paid step will cost before you run it." It uploads the files, starts the fine-tune, quotes and
runs an eval on both models, then batches on the better one and downloads the results.

## Licence

MIT: see `LICENSE`. Use of Gridline's API is subject to Gridline's terms
(<https://gridlinegpu.com/terms>). The bundled third-party packages and their licences are listed in
`THIRD_PARTY_NOTICES.md`.
