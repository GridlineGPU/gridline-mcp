import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDist } from "../scripts/build.ts";
import { TOOLS } from "./tools.ts";
import { MCP_VERSION } from "./version.ts";

/**
 * The published artifact: the bundled dist/main.js must start under Node (not only Bun), speak MCP
 * over stdio and list every tool. Node must be on PATH; a
 * machine without it skips this file with a message rather than passing silently.
 */
const node = Bun.which("node");
const out = mkdtempSync(join(tmpdir(), "gridline-mcp-dist-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
// The published package carries package.json "type": "module", so Node loads dist/main.js as an ES module.
// The temporary build directory must say the same: Node 18 has no ES-syntax detection and
// would load a bare main.js as CommonJS ("Cannot use import statement outside a module").
writeFileSync(join(out, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
const PKG = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  name: string;
  version: string;
  private?: boolean;
  bin: Record<string, string>;
  files: string[];
  dependencies?: Record<string, string>;
  license: string;
  mcpName?: string;
  repository?: { type: string; url: string };
};
const REPO_URL = "https://github.com/GridlineGPU/gridline-mcp";

/** Send JSON-RPC lines to the server over stdio and collect the answers by id. */
async function converse(main: string, messages: object[], wantIds: number[]) {
  const child = Bun.spawn([node ?? "node", main], {
    env: {
      PATH: process.env.PATH ?? "",
      GRIDLINE_TOKEN: "glk_test_dist_0123456789",
      GRIDLINE_BASE_URL: "http://localhost:9",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  for (const message of messages) child.stdin.write(`${JSON.stringify(message)}\n`);
  await child.stdin.flush();
  const answers = new Map<number, Record<string, unknown>>();
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 20_000;
  while (wantIds.some((id) => !answers.has(id)) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        const parsed = JSON.parse(line) as { id?: number };
        if (typeof parsed.id === "number") answers.set(parsed.id, parsed);
      }
      newline = buffer.indexOf("\n");
    }
  }
  child.kill();
  const stderr = await new Response(child.stderr).text();
  return { answers, stderr };
}

describe("published package shape", () => {
  test("public, scoped, versioned, with the binary and only built files", () => {
    expect(PKG.name).toBe("@gridlinegpu/mcp");
    expect(PKG.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(MCP_VERSION).toBe(PKG.version);
    expect(PKG.private).toBeUndefined();
    expect(PKG.bin).toEqual({ "gridline-mcp": "./dist/main.js" });
    expect(PKG.files).toEqual(["dist/main.js", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]);
    // Everything is bundled: no runtime dependency is installed with the package.
    expect(PKG.dependencies).toBeUndefined();
    // MIT; the LICENSE file ships in the tarball.
    expect(PKG.license).toBe("MIT");
    const licence = readFileSync(new URL("../LICENSE", import.meta.url), "utf8");
    expect(licence.startsWith("MIT License\n\nCopyright (c) 2026 Gridline\n")).toBe(true);
  });

  test("the README's tool table is the server's, with the same spending flags", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const t of TOOLS)
      expect(readme).toContain(`| \`${t.name}\` | ${t.spends ? "yes" : "no"} |`);
    const rows = readme.split("\n").filter((line) => /^\| `[a-z_]+` \| (yes|no) \|/.test(line));
    expect(rows).toHaveLength(TOOLS.length);
    expect(readme).toContain("confirm_spend: true");
    expect(readme).toContain("GRIDLINE_TOKEN");
    expect(readme).not.toMatch(/\$\s?\d/);
  });

  test("server.json (official MCP Registry) names this package, at this version", () => {
    // The registry verifies npm ownership by reading package.json "mcpName" from the published
    // version, so mcpName, server.json and the package version must agree before a publish.
    const server = JSON.parse(readFileSync(new URL("../server.json", import.meta.url), "utf8")) as {
      $schema: string;
      name: string;
      description: string;
      version: string;
      websiteUrl: string;
      repository?: { url: string; source: string };
      packages: {
        registryType: string;
        registryBaseUrl: string;
        identifier: string;
        version: string;
        transport: { type: string };
        environmentVariables: { name: string; isRequired: boolean; isSecret: boolean }[];
      }[];
    };
    const mcpName = PKG.mcpName;
    expect(mcpName).toBe("io.github.GridlineGPU/mcp");
    expect(server.name).toBe("io.github.GridlineGPU/mcp");
    expect(server.$schema).toBe(
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    );
    expect(server.version).toBe(PKG.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.websiteUrl).toBe("https://gridlinegpu.com/docs/agents");
    // The public mirror of this package (the monorepo itself is private).
    expect(server.repository).toEqual({ url: REPO_URL, source: "github" });
    expect(PKG.repository).toEqual({ type: "git", url: `git+${REPO_URL}.git` });
    expect(server.packages).toHaveLength(1);
    const npm = server.packages[0];
    if (npm === undefined) throw new Error("server.json lists no package");
    expect(npm.registryType).toBe("npm");
    expect(npm.registryBaseUrl).toBe("https://registry.npmjs.org");
    expect(npm.identifier).toBe(PKG.name);
    expect(npm.version).toBe(PKG.version);
    expect(npm.transport).toEqual({ type: "stdio" });
    const token = npm.environmentVariables.find((v) => v.name === "GRIDLINE_TOKEN");
    expect(token?.isRequired).toBe(true);
    expect(token?.isSecret).toBe(true);
    expect(npm.environmentVariables.map((v) => v.name).sort()).toEqual([
      "GRIDLINE_BASE_URL",
      "GRIDLINE_TOKEN",
    ]);
    // server.json is registry metadata, not part of the npm tarball.
    expect(PKG.files).not.toContain("server.json");
  });

  test("the README has install config for Claude Code, Cursor and Claude Desktop", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toContain("### Claude Code");
    expect(readme).toContain("claude mcp add gridline");
    expect(readme).toContain("### Cursor");
    expect(readme).toContain("~/.cursor/mcp.json");
    expect(readme).toContain("### Claude Desktop");
    expect(readme).toContain("claude_desktop_config.json");
    expect(readme).toContain('"args": ["-y", "@gridlinegpu/mcp"]');
    expect(readme).toContain("io.github.GridlineGPU/mcp");
  });
});

describe.skipIf(node === null)("dist/main.js under Node", () => {
  test("builds one executable ES module with a Node shebang, and the notices", async () => {
    const result = await buildDist(out);
    const code = readFileSync(result.mainPath, "utf8");
    expect(code.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(code).not.toContain("#!/usr/bin/env bun");
    expect(statSync(result.mainPath).mode & 0o111).not.toBe(0);
    const notices = readFileSync(result.noticesPath, "utf8");
    expect(result.packages.some((p) => p.startsWith("@modelcontextprotocol/sdk@1.32.2"))).toBe(
      true,
    );
    expect(result.packages.some((p) => p.startsWith("zod@"))).toBe(true);
    for (const p of result.packages)
      expect(notices).toContain(`## ${p.replace(/@([^@]+)$/, " $1")}`);
  }, 60_000);

  test("answers MCP initialize and tools/list over stdio", async () => {
    const main = join(out, "main.js");
    const { answers, stderr } = await converse(
      main,
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "dist-test", version: "0.0.0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
      [1, 2],
    );
    const init = answers.get(1)?.result as { serverInfo?: { name?: string } } | undefined;
    expect(init?.serverInfo?.name).toBe("gridline");
    expect((init as { serverInfo?: { version?: string } }).serverInfo?.version).toBe(MCP_VERSION);
    const listed = answers.get(2)?.result as { tools?: Array<{ name: string }> } | undefined;
    expect((listed?.tools ?? []).map((t) => t.name).sort()).toEqual(
      TOOLS.map((t) => t.name).sort(),
    );
    expect(stderr).not.toContain("glk_test_dist_0123456789");
  }, 60_000);

  test("without GRIDLINE_TOKEN it exits 2 under Node with a plain message", async () => {
    const child = Bun.spawn([node ?? "node", join(out, "main.js")], {
      env: { PATH: process.env.PATH ?? "" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("Set GRIDLINE_TOKEN");
  });
});

if (node === null)
  test("dist checks need Node on PATH", () => {
    expect(node).toBeNull();
  });
