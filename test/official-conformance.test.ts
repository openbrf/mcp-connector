import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { type Instance, startInstance } from "./harness.ts";

const run = promisify(execFile);

/**
 * The MCP project's own conformance runner, pointed at the connector.
 *
 * Only the scenarios that hold for any server are run. The rest require
 * fixture tools, prompts or resources of their own, or, like the DNS
 * rebinding check, apply to a local server without authentication, which the
 * connector's Bearer-only route is not. The runner cannot send a token, so the
 * stand-in gate admits it as a connected app.
 */
const SCENARIOS = ["server-initialize", "ping", "tools-list"] as const;

describe("the MCP conformance runner", () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await startInstance({ admitAll: true });
  });

  afterAll(async () => {
    await instance?.close();
  });

  it.each(SCENARIOS)(
    "passes %s",
    async (scenario) => {
      const { stdout } = await run(
        "pnpm",
        [
          "exec",
          "conformance",
          "server",
          "--url",
          instance.url.href,
          "--scenario",
          scenario,
        ],
        { encoding: "utf8", timeout: 60_000 },
      );

      expect(stdout).toMatch(/Passed: (\d+)\/\1, 0 failed/);
    },
    90_000,
  );
});
