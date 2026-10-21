import "reflect-metadata";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

import type { PluginModuleFactory } from "@openbrf/plugin-sdk";
import { afterEach, describe, expect, it } from "vitest";

import type { EntitlementState } from "../src/host-contract.ts";
import { type Instance, standInHost, startInstance } from "./harness.ts";

/**
 * The route the connector's screen reads, from the bundle the package ships.
 *
 * Who may read it is the host's guard, which reads the capabilities the route
 * declares; that the route declares the right ones is what is tested here.
 */

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { openbrf: { licence: { issuer: { name: string; url: string } } } };

let instance: Instance | undefined;

afterEach(async () => {
  await instance?.close();
  instance = undefined;
});

async function readStatus(
  entitlement: EntitlementState | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  instance = await startInstance({ entitlement });
  return fetch(new URL("/api/plugin/mcp-connector/status", instance.url), {
    headers,
  });
}

describe("the status route", () => {
  it("answers with the host's finding and the manifest's issuer", async () => {
    const licence: EntitlementState = {
      status: "expired",
      licenceId: "lic-1",
      validUntil: "2026-09-30",
    };
    const response = await readStatus(licence);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      licence,
      endsInDays: null,
      issuer: manifest.openbrf.licence.issuer,
    });
  });

  it("answers null on a host that cannot judge a licence", async () => {
    const response = await readStatus(undefined);

    expect(response.status).toBe(200);
    expect(((await response.json()) as { licence: unknown }).licence).toBe(
      null,
    );
  });

  it("refuses a connected app, which is told no more than that a licence is required", async () => {
    const response = await readStatus(
      { status: "absent" },
      { authorization: "Bearer read" },
    );

    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("absent");
  });

  it("asks the host for the board's reading of the configuration", async () => {
    const require = createRequire(import.meta.url);
    const { createPlugin } = require("../dist/server.cjs") as {
      createPlugin: PluginModuleFactory;
    };
    const module = await createPlugin(
      standInHost({ entitlement: undefined, schemas: true, invoked: [] }),
    );
    const byPath = new Map(
      (module.controllers ?? []).map((controller) => [
        Reflect.getMetadata("path", controller) as string,
        controller,
      ]),
    );

    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        byPath.get("status") as object,
      ),
    ).toEqual(["association:read"]);
    // The MCP route is held to the connector's floor and to a token for it.
    expect(
      Reflect.getMetadata(
        "openbrf:required-capabilities",
        byPath.get("/") as object,
      ),
    ).toBeUndefined();
  });
});
