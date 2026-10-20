import {
  type CallToolResult,
  createMcpHandler,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from "@modelcontextprotocol/server";
import type { ActionRequest } from "@openbrf/plugin-sdk";

import {
  type ConnectorHost,
  type DescribeActions,
  describeOf,
  isActionRefusal,
} from "./host-contract.ts";
import { toolFor } from "./tools.ts";

/**
 * The MCP server a connected app talks to.
 *
 * Stateless: every HTTP request is served by a server built for it alone, from
 * the request the host authenticated, so the person, the connected app and
 * the scope are the host's reading of that request and never something the
 * connector carries between calls. Nothing is cached either. Which tools a
 * client is offered is the host's listing at the moment of the call, so an
 * action an administrator disarms, a capability a person loses and a token
 * the member revokes all bite on the next request.
 *
 * The SDK serves both protocol eras from the one server definition: the
 * 2026-07-28 revision, and 2025-era clients through its stateless fallback.
 */

/** The package's version, written in by the build. */
declare const CONNECTOR_VERSION: string;

export const SERVER_INFO = {
  name: "openbrf-mcp-connector",
  version: CONNECTOR_VERSION,
} as const;

/**
 * The JSON-RPC error code for a request this connector will not serve.
 *
 * In JSON-RPC's range for server errors, at a value MCP does not define. A
 * client reads `data.reason` for what it means.
 */
export const NOT_SERVED_CODE = -32050;

/** Why the connector answers a request without serving it. */
export type NotServedReason = "entitlement-required" | "host-unsupported";

const NOT_SERVED_MESSAGES: Record<NotServedReason, string> = {
  "entitlement-required":
    "The MCP Connector is not licensed on this instance. The board enters a licence on the instance's licence screen.",
  "host-unsupported":
    "This instance is older than the MCP Connector. Update the instance to use it.",
};

/**
 * Answers one HTTP request on the connector's route.
 *
 * `request` is the web-standard request the SDK reads; `hostRequest` is the
 * request the host's own route received, which is the only thing dispatch
 * takes. `parsedBody` is the body the host has already parsed.
 */
export async function serveMcp(
  host: ConnectorHost,
  hostRequest: ActionRequest,
  request: Request,
  parsedBody: unknown,
): Promise<Response> {
  if (!isConnectedAppRequest(hostRequest)) {
    return tokenRequired();
  }

  // A request without a body to read is a 2025-era session operation, which
  // stateless serving answers with 405 whatever the licence says.
  if (request.method === "POST") {
    const reason = await notServedReason(host);
    if (reason !== null) {
      return notServed(parsedBody, reason);
    }
  }

  const describe = describeOf(host);
  if (describe === null) {
    return notServed(parsedBody, "host-unsupported");
  }

  const refused: { challenge?: string } = {};
  const handler = createMcpHandler(
    () => buildServer(host, describe, hostRequest, refused),
    // Answered as JSON: the stream the SDK upgrades to is for a message sent
    // before the result, and this server sends none.
    { legacy: "stateless" },
  );
  try {
    const response = await handler.fetch(request, { parsedBody });
    if (refused.challenge !== undefined) {
      return insufficientScope(refused.challenge);
    }
    return response;
  } finally {
    await handler.close();
  }
}

/**
 * Whether the host admitted this request on a connected app's token.
 *
 * The host makes the connector's route Bearer-only, so this holds for every
 * request it serves. It is checked again because a connector installed while
 * another plugin holds the instance's protected resource is served like any
 * plugin, on the browser's session: answering MCP there would let a page the
 * member has open act as them without a connected app being involved.
 *
 * Read off the request structurally: these are the host's own fields, set on
 * the request before the route runs, and a plugin has no package to import
 * them from. The token itself is never on it, only the app it was issued to.
 */
export function isConnectedAppRequest(hostRequest: ActionRequest): boolean {
  const token = (hostRequest as { token?: { clientId?: unknown } }).token;
  return typeof token?.clientId === "string" && token.clientId.length > 0;
}

/**
 * Why the connector will not serve this request, or null when it will.
 *
 * Without an active entitlement the connector is dormant (ADR 0042): it lists
 * no tools and makes no calls, and says only that a licence is required -
 * not which state the licence is in or its dates, which are the board's to
 * read on the licence screen rather than a connected app's. A host with no
 * `entitlements` cannot tell a licensed instance from one that is not, so the
 * connector stays dormant there too.
 */
async function notServedReason(
  host: ConnectorHost,
): Promise<NotServedReason | null> {
  const state = await host.entitlements?.get();
  return state?.status === "active" ? null : "entitlement-required";
}

function buildServer(
  host: ConnectorHost,
  describe: DescribeActions,
  hostRequest: ActionRequest,
  refused: { challenge?: string },
): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: { tools: { listChanged: false } },
  });

  server.setRequestHandler("tools/list", async () => ({
    tools: (await describe(hostRequest)).map(toolFor),
  }));

  server.setRequestHandler("tools/call", async (request) => {
    const { name, arguments: input } = request.params;

    /*
     * Read from the listing, so a client is answered alike for a tool that
     * does not exist and one it may not call, as the catalogue answers by
     * name - a call cannot be used to ask what the instance has. The listing
     * is also what holds the output schema the result is shaped against.
     */
    const offered = (await describe(hostRequest)).find(
      (action) => action.name === name,
    );
    if (offered === undefined) {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Unknown tool.");
    }

    let output: unknown;
    try {
      output = await host.actions.invoke(hostRequest, name, input ?? {});
    } catch (cause) {
      return refusalResult(cause, refused);
    }

    return server.projectCallToolResult(
      {
        content: [{ type: "text", text: JSON.stringify(output) }],
        structuredContent: output as CallToolResult["structuredContent"],
      },
      offered.outputSchema,
    );
  });

  return server;
}

/**
 * A refused call, rendered the way the host's refusal table says.
 *
 * A `protocol` refusal means the call never happened and becomes a JSON-RPC
 * error. A `tool-result` one happened and was refused, and becomes a result
 * with `isError` set, carrying the reason, the retry verdict and the
 * particulars, so a model can tell a request it should change from one that
 * will never work. Anything that is not a refusal is a fault, answered as an
 * internal error without its message, which may hold the host's internals.
 *
 * A refusal carrying a bearer challenge is the token lacking a scope. It is
 * noted, and the HTTP response becomes a 403 with that challenge, so the
 * client can ask the member for the scope and try again (ADR 0009).
 */
export function refusalResult(
  cause: unknown,
  refused: { challenge?: string },
): CallToolResult {
  if (!isActionRefusal(cause)) {
    throw new ProtocolError(
      ProtocolErrorCode.InternalError,
      "The call failed.",
    );
  }
  if (cause.challenge !== undefined) {
    refused.challenge = cause.challenge;
  }
  const data = {
    reason: cause.reason,
    retry: cause.retry,
    details: cause.details(),
  };
  if (cause.transport === "protocol") {
    throw new ProtocolError(
      cause.reason === "unknown-action"
        ? ProtocolErrorCode.InvalidParams
        : ProtocolErrorCode.InternalError,
      cause.message,
      data,
    );
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ message: cause.message, ...data }),
      },
    ],
  };
}

/**
 * The answer to a request the connector will not serve, in JSON-RPC.
 *
 * Every request in the body gets the same error; a notification or a
 * response is acknowledged with 202 and nothing else, as MCP has a server do
 * with a message that needs no answer.
 */
export function notServed(
  parsedBody: unknown,
  reason: NotServedReason,
): Response {
  const messages = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
  if (!messages.every(isJsonRpcMessage)) {
    return json(400, {
      jsonrpc: "2.0",
      id: null,
      error: {
        code: ProtocolErrorCode.InvalidRequest,
        message: "The body is not a JSON-RPC message.",
      },
    });
  }
  const errors = messages
    .filter((message) => "method" in message && "id" in message)
    .map((message) => ({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: NOT_SERVED_CODE,
        message: NOT_SERVED_MESSAGES[reason],
        data: { reason },
      },
    }));
  if (errors.length === 0) {
    return new Response(null, { status: 202 });
  }
  return json(200, Array.isArray(parsedBody) ? errors : errors[0]);
}

function isJsonRpcMessage(
  value: unknown,
): value is { jsonrpc: "2.0"; id?: string | number | null; method?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

function tokenRequired(): Response {
  return json(403, {
    error: "invalid_request",
    error_description: "This route serves connected apps only.",
  });
}

function insufficientScope(challenge: string): Response {
  return new Response(
    JSON.stringify({
      error: "insufficient_scope",
      error_description: "The connected app's access does not cover this.",
    }),
    {
      status: 403,
      headers: {
        "content-type": "application/json",
        "www-authenticate": challenge,
      },
    },
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
