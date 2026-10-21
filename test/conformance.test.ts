import {
  Client as ClientV2,
  StreamableHTTPClientTransport as TransportV2,
} from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport as TransportV1 } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ACTIONS,
  CHALLENGE,
  type Instance,
  startInstance,
  TOKENS,
} from "./harness.ts";

/**
 * The connector against real MCP clients, over HTTP.
 *
 * Three clients, because an association's members bring what they have: the
 * current SDK on the 2026-07-28 revision, the same SDK pinned to the 2025
 * handshake, and the previous SDK, which is what most clients in use today are
 * built on. Each of them signs in with a token, lists the tools and calls them.
 */

interface Connected {
  listTools(): Promise<{
    tools: {
      name: string;
      title?: string;
      description?: string;
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      annotations?: Record<string, unknown>;
    }[];
  }>;
  callTool(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<{
    isError?: boolean;
    content?: unknown;
    structuredContent?: unknown;
  }>;
  serverName(): string | undefined;
  protocolVersion(): string | undefined;
  close(): Promise<void>;
}

type Connect = (url: URL, token: keyof typeof TOKENS) => Promise<Connected>;

const CLIENTS: [string, string, Connect][] = [
  [
    "SDK v2 on 2026-07-28",
    "2026-07-28",
    async (url, token) => {
      // The SDK speaks 2025 unless asked to negotiate.
      const client = new ClientV2(
        { name: "conformance", version: "1.0.0" },
        { versionNegotiation: { mode: "auto" } },
      );
      await client.connect(
        new TransportV2(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      return wrap(
        client,
        () => client.getServerVersion()?.name,
        () => client.getNegotiatedProtocolVersion(),
      );
    },
  ],
  [
    "SDK v2 on the 2025 handshake",
    "2025-11-25",
    async (url, token) => {
      const client = new ClientV2({ name: "conformance", version: "1.0.0" });
      await client.connect(
        new TransportV2(url, {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
        { prior: { kind: "legacy" } },
      );
      return wrap(
        client,
        () => client.getServerVersion()?.name,
        () => client.getNegotiatedProtocolVersion(),
      );
    },
  ],
  [
    "SDK v1",
    "2025-11-25",
    async (url, token) => {
      const client = new ClientV1({ name: "conformance", version: "1.0.0" });
      const transport = new TransportV1(url, {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport);
      return wrap(
        client,
        () => client.getServerVersion()?.name,
        () => transport.protocolVersion,
      );
    },
  ],
];

function wrap(
  client: {
    listTools(): Promise<unknown>;
    callTool(params: {
      name: string;
      arguments?: Record<string, unknown>;
    }): Promise<unknown>;
    close(): Promise<void>;
  },
  serverName: () => string | undefined,
  protocolVersion: () => string | undefined,
): Connected {
  return {
    listTools: () => client.listTools() as ReturnType<Connected["listTools"]>,
    callTool: (params) =>
      client.callTool(params) as ReturnType<Connected["callTool"]>,
    serverName,
    protocolVersion,
    close: () => client.close(),
  };
}

function textOf(result: { content?: unknown }): unknown {
  const [first] = result.content as { type: string; text: string }[];
  return JSON.parse(first?.text ?? "null");
}

describe.each(CLIENTS)("%s", (_label, revision, connect) => {
  let instance: Instance;
  let client: Connected;

  beforeAll(async () => {
    instance = await startInstance();
    client = await connect(instance.url, "write");
  });

  afterAll(async () => {
    await client?.close();
    await instance?.close();
  });

  it("connects to the connector on the revision it asked for", () => {
    expect(client.serverName()).toBe("openbrf-mcp-connector");
    expect(client.protocolVersion()).toBe(revision);
  });

  it("lists every action the host offers, as a tool", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(
      ACTIONS.map((action) => action.name).sort(),
    );
    const create = tools.find((tool) => tool.name === "news_create");
    expect(create).toMatchObject({
      title: "Title of news_create",
      description: "What news_create does.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string", description: "The headline." } },
        required: ["title", "body"],
        additionalProperties: false,
      },
    });
    // The dialect is kept, as SEP-1613 asks of a server.
    expect(create?.inputSchema).toHaveProperty(
      "$schema",
      "https://json-schema.org/draft/2020-12/schema",
    );
  });

  it("states every hint a client decides with", async () => {
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(
      tools.map((tool) => [tool.name, tool.annotations]),
    );

    expect(hints.facts_read).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    // A create overwrites nothing; an update does; a delete asks first.
    expect(hints.news_create).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(hints.page_update).toMatchObject({ destructiveHint: true });
    expect(hints.news_delete).toMatchObject({ destructiveHint: true });
  });

  it("calls an action and answers with its output", async () => {
    const result = await client.callTool({ name: "facts_read" });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: "BRF Exempel",
      apartments: 42,
    });
    expect(textOf(result)).toEqual({ name: "BRF Exempel", apartments: 42 });
  });

  it("dispatches as the connected app the host admitted", async () => {
    await client.callTool({
      name: "news_create",
      arguments: { title: "Stämma", body: "Välkomna." },
    });

    expect(instance.state.invoked.at(-1)).toEqual({
      name: "news_create",
      input: { title: "Stämma", body: "Välkomna." },
      clientId: TOKENS.write.clientId,
    });
  });

  it("answers a refusal on the merits as a tool result a model can act on", async () => {
    const result = await client.callTool({
      name: "page_update",
      arguments: { slug: "styrelsen" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toEqual({
      message: "That address is taken.",
      reason: "slug-taken",
      retry: "after-edit",
      details: { slugs: ["styrelsen"] },
    });
  });

  it("answers a refused input with the paths, as a tool result", async () => {
    const result = await client.callTool({
      name: "news_create",
      arguments: { title: "", body: "x" },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatchObject({
      reason: "invalid-body",
      retry: "after-edit",
    });
  });

  it("answers a tool it does not offer as a protocol error", async () => {
    // In Swedish, the product's default: the client asks for no language.
    await expect(client.callTool({ name: "register_member" })).rejects.toThrow(
      /Okänt verktyg/,
    );
    expect(instance.state.invoked.map((call) => call.name)).not.toContain(
      "register_member",
    );
  });

  it("answers a fault as an internal error without its message", async () => {
    const failure = await client.callTool({ name: "faulty_read" }).then(
      () => expect.unreachable("the call failed"),
      (cause: unknown) => cause as Error,
    );

    expect(failure.message).toMatch(/Anropet misslyckades/);
    expect(failure.message).not.toMatch(/ECONNREFUSED|secret/);
  });
});

describe("a token without the scope a call needs", () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await startInstance();
  });

  afterAll(async () => {
    await instance?.close();
  });

  it("is answered 403 with the host's challenge, so the client can ask for it", async () => {
    // ADR 0009: the challenge names every scope the instance issues, and the
    // client asks the member for what it lacks in one round trip.
    const response = await post(instance.url, "read", {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "news_create", arguments: { title: "x", body: "y" } },
    });

    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(CHALLENGE);
  });

  it("still reads", async () => {
    const response = await post(instance.url, "read", {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "facts_read", arguments: {} },
    });

    expect(response.status).toBe(200);
    expect(await jsonRpcResult(response)).toMatchObject({
      structuredContent: { name: "BRF Exempel" },
    });
  });

  it("reaches the v1 client as a refusal it can recognise", async () => {
    const client = new ClientV1({ name: "conformance", version: "1.0.0" });
    await client.connect(
      new TransportV1(instance.url, {
        requestInit: { headers: { authorization: "Bearer read" } },
      }),
    );
    try {
      await expect(
        client.callTool({
          name: "news_create",
          arguments: { title: "x", body: "y" },
        }),
      ).rejects.toThrow(/403|insufficient_scope/i);
    } finally {
      await client.close();
    }
  });
});

describe("a dormant connector", () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await startInstance({ entitlement: { status: "absent" } });
  });

  afterAll(async () => {
    await instance?.close();
  });

  it.each(CLIENTS)(
    "refuses %s at sign-in, saying a licence is required",
    async (_label, _revision, connect) => {
      await expect(connect(instance.url, "write")).rejects.toThrow(
        /inte licensierad/,
      );
    },
  );

  it.each([
    [
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "c", version: "1" },
      },
    ],
    ["tools/list", {}],
    ["tools/call", { name: "facts_read", arguments: {} }],
  ])(
    "answers %s with entitlement-required and no dates",
    async (method, params) => {
      const response = await post(instance.url, "write", {
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32050, data: { reason: "entitlement-required" } },
      });
      expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}|lic-/);
    },
  );

  it("calls nothing", () => {
    expect(instance.state.invoked).toEqual([]);
  });

  it("acknowledges a notification and nothing more", async () => {
    const response = await post(instance.url, "write", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it.each<[string, Partial<Instance["state"]>]>([
    [
      "has expired",
      {
        entitlement: {
          status: "expired",
          licenceId: "lic-1",
          validUntil: "2026-01-01",
        },
      },
    ],
    [
      "was issued to another instance",
      { entitlement: { status: "wrong-instance", licenceId: "lic-1" } },
    ],
    ["was tampered with", { entitlement: { status: "tampered" } }],
    [
      "does not cover this release",
      {
        entitlement: {
          status: "version-not-covered",
          licenceId: "lic-1",
          updatesUntil: "2026-01-01",
          released: "2026-10-20",
        },
      },
    ],
    [
      "is not yet valid",
      {
        entitlement: {
          status: "not-yet-valid",
          licenceId: "lic-1",
          issuedOn: "2027-01-01",
        },
      },
    ],
    [
      "cannot be read, on a host without entitlements",
      { entitlement: undefined },
    ],
  ])("stays dormant when the licence %s", async (_case, state) => {
    const other = await startInstance(state);
    try {
      const response = await post(other.url, "write", {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      });
      const body = await response.json();
      expect(body).toMatchObject({
        error: { data: { reason: "entitlement-required" } },
      });
      expect(JSON.stringify(body)).not.toMatch(/\d{4}-\d{2}-\d{2}|lic-/);
    } finally {
      await other.close();
    }
  });
});

describe("the route", () => {
  let instance: Instance;

  beforeAll(async () => {
    instance = await startInstance();
  });

  afterAll(async () => {
    await instance?.close();
  });

  it("refuses a request the host admitted on the browser's session", async () => {
    // Only possible when another plugin holds the instance's protected
    // resource: the connector's route is then an ordinary plugin route.
    const response = await fetch(instance.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-test-session": "1",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "invalid_request",
      error_description: "Den här adressen tar bara emot anslutna appar.",
    });
    expect(instance.state.invoked).toEqual([]);
  });

  it("serves nothing on a host that cannot say whether a connected app sent the request", async () => {
    const old = await startInstance({ client: false });
    try {
      const response = await post(old.url, "write", {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "facts_read", arguments: {} },
      });
      expect(await response.json()).toMatchObject({
        id: 5,
        error: { code: -32050, data: { reason: "host-unsupported" } },
      });
      expect(old.state.invoked).toEqual([]);
    } finally {
      await old.close();
    }
  });

  it.each([
    ["tools/list", {}],
    ["tools/call", { name: "facts_read", arguments: {} }],
  ])(
    "answers %s as an internal error without the message of a listing that failed",
    async (method, params) => {
      const failing = await startInstance({
        listFailure: new Error("database lookup failed: PRIVATE-MARKER-6446"),
      });
      try {
        const response = await post(
          failing.url,
          "write",
          { jsonrpc: "2.0", id: 6, method, params },
          { "accept-language": "en-GB,en;q=0.9" },
        );
        const message = await jsonRpcMessage(response);
        expect(message).toMatchObject({
          id: 6,
          error: { code: -32603, message: "The request failed." },
        });
        expect(JSON.stringify(message)).not.toMatch(/PRIVATE-MARKER|database/);
        expect(failing.state.invoked).toEqual([]);
      } finally {
        await failing.close();
      }
    },
  );

  it.each([
    ["en-US,en;q=0.9", "This route serves connected apps only."],
    [
      "sv-SE,sv;q=0.9,en;q=0.8",
      "Den här adressen tar bara emot anslutna appar.",
    ],
    ["de-DE", "Den här adressen tar bara emot anslutna appar."],
  ])(
    "answers in the language the request asks for (%s)",
    async (acceptLanguage, sentence) => {
      const response = await fetch(instance.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "accept-language": acceptLanguage,
          "x-test-session": "1",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

      expect(await response.json()).toMatchObject({
        error_description: sentence,
      });
    },
  );

  it("answers a 2025 session stream request with 405, serving statelessly", async () => {
    const response = await fetch(instance.url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: "Bearer write",
      },
    });

    expect(response.status).toBe(405);
  });

  it.each([false, "partial"] as const)(
    "says the host is too old when its listing lacks schemas (%s)",
    async (schemas) => {
      const old = await startInstance({ schemas });
      try {
        const response = await post(old.url, "write", {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
        });
        expect(await jsonRpcMessage(response)).toMatchObject({
          error: { data: { reason: "host-unsupported" } },
        });
      } finally {
        await old.close();
      }
    },
  );

  it("refuses to call a tool on a host whose listing lacks schemas", async () => {
    const old = await startInstance({ schemas: false });
    try {
      const response = await post(old.url, "write", {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: ACTIONS[0]!.name, arguments: {} },
      });
      expect(await jsonRpcMessage(response)).toMatchObject({
        error: { data: { reason: "host-unsupported" } },
      });
      expect(old.state.invoked).toEqual([]);
    } finally {
      await old.close();
    }
  });
});

async function post(
  url: URL,
  token: keyof typeof TOKENS,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-11-25",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** The result of a JSON-RPC response, whether sent as JSON or as one SSE event. */
async function jsonRpcResult(response: Response): Promise<unknown> {
  return ((await jsonRpcMessage(response)) as { result: unknown }).result;
}

/** The one JSON-RPC message a response carries, as JSON or as an event. */
async function jsonRpcMessage(response: Response): Promise<unknown> {
  const text = await response.text();
  const json = response.headers
    .get("content-type")
    ?.includes("text/event-stream")
    ? text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice("data: ".length))
        .join("")
    : text;
  return JSON.parse(json);
}
