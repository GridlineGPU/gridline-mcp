import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Build the publishable server: one self-contained ES module for Node (`dist/main.js`, every
 * dependency bundled, so the published package has no runtime dependencies), with a Node shebang
 * and the executable bit, plus THIRD_PARTY_NOTICES.md naming each bundled package with its
 * licence text. `bun scripts/build.ts [outdir]` (default: this package's dist/; the notices file
 * goes next to package.json unless an outdir is given, then into it).
 */

const PACKAGE_DIR = resolve(import.meta.dir, "..");
const SHEBANG = "#!/usr/bin/env node\n";

export type BuildResult = Readonly<{ mainPath: string; noticesPath: string; packages: string[] }>;

/** The package directory (…/node_modules/<name> or …/node_modules/@scope/<name>) of a source path. */
function packageDirOf(source: string): string | null {
  const parts = source.split(/[\\/]/);
  const at = parts.lastIndexOf("node_modules");
  if (at < 0 || at + 1 >= parts.length) return null;
  const first = parts[at + 1] ?? "";
  const length = first.startsWith("@") ? 2 : 1;
  return parts.slice(0, at + 1 + length).join(sep);
}

async function licenceText(dir: string): Promise<string> {
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE", "license.md"]) {
    try {
      return (await readFile(join(dir, name), "utf8")).trim();
    } catch {
      // try the next spelling
    }
  }
  return "(no licence file in the package; see its package.json licence field)";
}

export async function buildDist(outdir = join(PACKAGE_DIR, "dist")): Promise<BuildResult> {
  const work = await mkdtemp(join(tmpdir(), "gridline-mcp-build-"));
  try {
    const built = await Bun.build({
      entrypoints: [join(PACKAGE_DIR, "src/main.ts")],
      target: "node",
      format: "esm",
      outdir: work,
      naming: "main.js",
      sourcemap: "external",
      minify: false,
    });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const code = (await readFile(join(work, "main.js"), "utf8")).replace(/^#![^\n]*\n/, "");
    const map = JSON.parse(await readFile(join(work, "main.js.map"), "utf8")) as {
      sources: string[];
    };
    await mkdir(outdir, { recursive: true });
    const mainPath = join(outdir, "main.js");
    await writeFile(mainPath, `${SHEBANG}${code}`);
    await chmod(mainPath, 0o755);

    // Every bundled npm package, from the source map's inputs, with its licence.
    const dirs = new Set<string>();
    for (const source of map.sources) {
      const dir = packageDirOf(resolve(work, source));
      if (dir !== null) dirs.add(dir);
    }
    const entries: Array<{ name: string; version: string; license: string; text: string }> = [];
    for (const dir of dirs) {
      const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as {
        name?: string;
        version?: string;
        license?: string;
      };
      entries.push({
        name: pkg.name ?? dir,
        version: pkg.version ?? "?",
        license: pkg.license ?? "?",
        text: await licenceText(dir),
      });
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const notices = [
      "# Third-party notices",
      "",
      "`dist/main.js` bundles the following packages. Each is used under its own licence, reproduced below.",
      "",
      ...entries.flatMap((e) => [
        `## ${e.name} ${e.version} (${e.license})`,
        "",
        "```",
        e.text,
        "```",
        "",
      ]),
    ].join("\n");
    const noticesPath =
      outdir === join(PACKAGE_DIR, "dist")
        ? join(PACKAGE_DIR, "THIRD_PARTY_NOTICES.md")
        : join(outdir, "THIRD_PARTY_NOTICES.md");
    await mkdir(dirname(noticesPath), { recursive: true });
    await writeFile(noticesPath, notices);
    return { mainPath, noticesPath, packages: entries.map((e) => `${e.name}@${e.version}`) };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const result = await buildDist(
    process.argv[2] === undefined ? undefined : resolve(process.argv[2]),
  );
  process.stdout.write(
    `built ${result.mainPath}\nnotices ${result.noticesPath} (${result.packages.length} packages)\n`,
  );
}
