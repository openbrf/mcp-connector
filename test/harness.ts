import "reflect-metadata";

import { createRequire } from "node:module";

import { NestFactory } from "@nestjs/core";
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from "@nestjs/platform-fastify";
import type { PluginModuleFactory } from "@openbrf/plugin-sdk";

import type {
  ActionWithSchemas,
  ActionRefusal,
  ConnectorHost,
  EntitlementState,
} from "../src/host-contract.ts";

/**
 * An instance with the connector installed, as far as the connector can tell.
 *
 * The connector is loaded from the bundle the package ships, `dist/server.cjs`,
 * and mounted under its own prefix in a NestJS application on Fastify, as the
 * host mounts it. What the host does around it is stood in for here, at the
 * boundary the connector actually reads:
 *
 * - the Bearer-only gate on the protected resource, which answers 401 without
 *   a token and otherwise marks the request with the person and the app;
 * - the action listing and dispatch, with the host's refusal shapes, and
 *   `actions.client`, answered from the gate's mark;
 * - the licence finding.
 *
 * The real gate and registry are the host's own and are tested there.
 */

export const RESOURCE_PATH = "/api/plugin/mcp-connector/mcp";

export const CHALLENGE =
  'Bearer error="insufficient_scope", scope="mcp:read mcp:write", resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/api/plugin/mcp-connector/mcp"';

/** The tokens the stand-in gate admits, and the scopes each carries. */
export const TOKENS = {
  write: { clientId: "client-write", scopes: ["mcp:read", "mcp:write"] },
  read: { clientId: "client-read", scopes: ["mcp:read"] },
} as const;

/** A request the gate admitted on the browser's session rather than a token. */
export const SESSION_HEADER = "x-test-session";

interface MarkedRequest {
  principal?: { personId: string };
  token?: { clientId: string; scopes: readonly string[] };
}

function description(
  name: string,
  overrides: Partial<ActionWithSchemas>,
): ActionWithSchemas {
  return {
    name,
    title: `Title of ${name}`,
    description: `What ${name} does.`,
    titleKey: `actions.${name}.title`,
    descriptionKey: `actions.${name}.description`,
    group: "site",
    groupTitle: "Website",
    groupTitleKey: "actions.group.site.title",
    capability: "site:manage",
    effect: "write",
    idempotent: false,
    additive: false,
    needsConfirmation: false,
    openWorld: false,
    personalData: [],
    surfaces: ["mcp"],
    errors: [],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    ...overrides,
  };
}

/** The actions the stand-in registry offers a connected app. */
export const ACTIONS: readonly ActionWithSchemas[] = [
  description("facts_read", {
    effect: "read",
    idempotent: true,
    outputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        name: { type: "string" },
        apartments: { type: "integer" },
      },
      required: ["name", "apartments"],
      additionalProperties: false,
    },
  }),
  description("news_create", {
    additive: true,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, description: "The headline." },
        body: { type: "string" },
        pinned: { type: "boolean", default: false },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
  }),
  description("page_update", {
    idempotent: true,
    errors: [
      {
        reason: "slug-taken",
        retry: "after-edit",
        messageKey: "siteAdmin.errors.slugTaken",
      },
    ],
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: { slug: { type: "string" } },
      required: ["slug"],
      additionalProperties: false,
    },
  }),
  description("news_delete", {
    effect: "delete",
    idempotent: true,
    needsConfirmation: true,
  }),
  description("faulty_read", { effect: "read", idempotent: true }),
];

function refusal(
  fields: Omit<ActionRefusal, "name" | "message" | "details"> & {
    message: string;
    details?: Record<string, readonly unknown[]>;
  },
): ActionRefusal {
  const { message, details = {}, ...rest } = fields;
  return Object.assign(new Error(message), {
    ...rest,
    name: "ActionRefusal" as const,
    details: () => details,
  });
}

/** What the stand-in registry does when an action is called. */
async function invoke(
  request: MarkedRequest,
  name: string,
  input: unknown,
): Promise<unknown> {
  const action = ACTIONS.find((each) => each.name === name);
  if (action === undefined) {
    throw refusal({
      kind: "registry",
      reason: "unknown-action",
      status: 404,
      transport: "protocol",
      retry: "never",
      message: "No such action.",
    });
  }
  if (
    action.effect !== "read" &&
    !(request.token?.scopes ?? []).includes("mcp:write")
  ) {
    throw refusal({
      kind: "registry",
      reason: "insufficient-scope",
      status: 403,
      transport: "tool-result",
      retry: "never",
      message: "This token does not carry mcp:write.",
      details: { scopes: ["mcp:write"] },
      challenge: CHALLENGE,
    });
  }
  const fields = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "facts_read":
      return { name: "BRF Exempel", apartments: 42 };
    case "news_create":
      if (typeof fields.title !== "string" || fields.title.length === 0) {
        throw refusal({
          kind: "invalid-body",
          reason: "invalid-body",
          status: 400,
          transport: "tool-result",
          retry: "after-edit",
          message: "The input is not valid.",
          details: { issues: [{ path: "title", message: "Required" }] },
        });
      }
      return { id: "news-1" };
    case "page_update":
      if (fields.slug === "styrelsen") {
        throw refusal({
          kind: "domain",
          reason: "slug-taken",
          status: 409,
          transport: "tool-result",
          retry: "after-edit",
          message: "That address is taken.",
          details: { slugs: ["styrelsen"] },
        });
      }
      return { id: "page-1" };
    case "faulty_read":
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 (database secret)");
    default:
      return { id: "done" };
  }
}

export interface HostState {
  /**
   * Admit a request without a token as the app holding `write`. For a client
   * that cannot send one, such as the MCP conformance runner.
   */
  admitAll?: boolean;
  /** What `host.entitlements.get()` answers; undefined removes the member. */
  entitlement: EntitlementState | undefined;
  /** Whether `actions.list` carries each action's schemas. */
  schemas: boolean | "partial";
  /** Whether the host has `actions.client`. */
  client: boolean;
  /** What `actions.list` rejects with instead of answering, if anything. */
  listFailure?: Error;
  /** Every call the connector dispatched. */
  invoked: { name: string; input: unknown; clientId: string | undefined }[];
}

export function standInHost(state: HostState): ConnectorHost {
  const actions = {
    register: () => undefined,
    list: async () => {
      if (state.listFailure !== undefined) {
        throw state.listFailure;
      }
      return ACTIONS.map(
        ({ inputSchema: _in, outputSchema: _out, ...summary }, index) =>
          state.schemas === true || (state.schemas === "partial" && index === 0)
            ? { ...summary, inputSchema: _in, outputSchema: _out }
            : summary,
      );
    },
    invoke: async (request: object, name: string, input: unknown) => {
      const marked = request as MarkedRequest;
      state.invoked.push({ name, input, clientId: marked.token?.clientId });
      return invoke(marked, name, input);
    },
    // The stand-in gate's own mark, which it alone writes.
    ...(state.client
      ? {
          client: (request: object) => {
            const { token } = request as MarkedRequest;
            return token === undefined
              ? null
              : { clientId: token.clientId, clientHost: "client.example" };
          },
        }
      : {}),
  };
  return {
    id: "mcp-connector",
    permissions: [],
    actions,
    get entitlements() {
      const entitlement = state.entitlement;
      return entitlement === undefined
        ? undefined
        : { get: async () => entitlement };
    },
  } as unknown as ConnectorHost;
}

export const ACTIVE: EntitlementState = {
  status: "active",
  licenceId: "lic-1",
  validUntil: "2027-11-30",
  updatesUntil: null,
};

export interface Instance {
  url: URL;
  state: HostState;
  close(): Promise<void>;
}

/** Boots an instance with the connector's bundle mounted, on a free port. */
export async function startInstance(
  initial: Partial<HostState> = {},
): Promise<Instance> {
  const state: HostState = {
    entitlement: ACTIVE,
    schemas: true,
    client: true,
    invoked: [],
    ...initial,
  };
  const require = createRequire(import.meta.url);
  const { createPlugin } = require("../dist/server.cjs") as {
    createPlugin: PluginModuleFactory;
  };
  const module = await createPlugin(standInHost(state));

  const adapter = new FastifyAdapter();
  adapter.getInstance().addHook("onRequest", async (request, reply) => {
    const marked = request as unknown as MarkedRequest;
    if (!request.url.startsWith(RESOURCE_PATH)) {
      // The connector's other routes are the browser's. A token is marked
      // anyway, standing in for a host that admitted one there.
      const token = Object.entries(TOKENS).find(
        ([name]) => request.headers.authorization === `Bearer ${name}`,
      )?.[1];
      if (token !== undefined) {
        marked.token = { clientId: token.clientId, scopes: token.scopes };
      }
      return;
    }
    if (request.headers[SESSION_HEADER] === "1") {
      marked.principal = { personId: "person-1" };
      return;
    }
    const header = state.admitAll
      ? "Bearer write"
      : (request.headers.authorization ?? "");
    const token = Object.entries(TOKENS).find(
      ([name]) => header === `Bearer ${name}`,
    )?.[1];
    if (token === undefined) {
      await reply
        .code(401)
        .header(
          "www-authenticate",
          'Bearer resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource/api/plugin/mcp-connector/mcp"',
        )
        .send({ error: "invalid_token" });
      return;
    }
    marked.principal = { personId: "person-1" };
    marked.token = { clientId: token.clientId, scopes: token.scopes };
  });

  const app = await NestFactory.create<NestFastifyApplication>(
    module,
    adapter,
    { logger: false },
  );
  app.setGlobalPrefix("api/plugin/mcp-connector");
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address() as { port: number };
  return {
    url: new URL(`http://127.0.0.1:${address.port}${RESOURCE_PATH}`),
    state,
    close: () => app.close(),
  };
}
