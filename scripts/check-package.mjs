import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { pluginPackageProblems } from "@openbrf/plugin-sdk";

import { languageOf, translate } from "../src/messages.ts";

/**
 * Packs the plugin and runs the SDK's package check over the tarball.
 *
 * The same check the catalog runs before it lists a release, against what is
 * published rather than the working tree: a dependency the installer could
 * not fetch, a bundle reaching for a module an installed plugin cannot
 * resolve, a missing entry.
 */
const scratch = await mkdtemp(join(tmpdir(), "mcp-connector-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", scratch], {
    stdio: "ignore",
  });
  const [tarball] = (await readdir(scratch)).filter((name) =>
    name.endsWith(".tgz"),
  );
  execFileSync("tar", ["-xzf", join(scratch, tarball), "-C", scratch]);
  const root = join(scratch, "package");

  const files = [];
  for (const entry of await readdir(root, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (entry.isFile()) {
      files.push(
        relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"),
      );
    }
  }
  const read = async (path) => {
    try {
      return await readFile(join(root, path), "utf8");
    } catch {
      return undefined;
    }
  };
  const packageJson = JSON.parse(await read("package.json"));
  const serverEntry = packageJson.openbrf?.entry?.server;
  const locale = async (language) => {
    const text = await read(`locales/${language}.json`);
    return text === undefined ? undefined : JSON.parse(text);
  };

  const problems = pluginPackageProblems({
    packageJson,
    files,
    serverBundle:
      serverEntry === undefined ? null : ((await read(serverEntry)) ?? null),
    locales: { sv: await locale("sv"), en: await locale("en") },
  });

  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    process.exitCode = 1;
  } else {
    console.log(
      translate(
        languageOf(
          process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG,
        ),
        "cli.packageCheckPasses",
        {
          tarball,
          count: files.length,
        },
      ),
    );
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
