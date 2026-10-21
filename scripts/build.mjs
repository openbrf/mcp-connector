import { readFile } from "node:fs/promises";
import { builtinModules } from "node:module";

import { build } from "esbuild";

/**
 * Builds the server entry point: one CommonJS bundle, `dist/server.cjs`.
 *
 * Run after `vite build`, which builds the view and empties `dist` first.
 *
 * An installed plugin sits on the instance's data volume, where nothing but
 * Node's built-ins and the packages the host shares can be resolved. So the
 * MCP SDK and everything it needs is bundled in, and the host's packages are
 * left external: NestJS because a second copy is a second, disconnected
 * framework, and zod because the host holds the one copy every plugin shares.
 */
const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

const hostShared = Object.keys(packageJson.peerDependencies);

await build({
  entryPoints: ["src/entry.cjs"],
  outfile: "dist/server.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    ...hostShared,
    ...hostShared.map((name) => `${name}/*`),
    ...builtinModules,
    "node:*",
  ],
  // The SDK's Node build, which reads JSON Schema with its bundled Ajv.
  conditions: ["node", "require"],
  define: {
    CONNECTOR_VERSION: JSON.stringify(packageJson.version),
    LICENCE_ISSUER: JSON.stringify(packageJson.openbrf.licence.issuer),
  },
  legalComments: "eof",
  logLevel: "info",
});
