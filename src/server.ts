import {
  Controller,
  Delete,
  type DynamicModule,
  ForbiddenException,
  Get,
  Module,
  Post,
  Req,
  Res,
  SetMetadata,
} from "@nestjs/common";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";

import { connectedApp, serveMcp } from "./connector.ts";
import type { ConnectorHost } from "./host-contract.ts";
import {
  type ConnectorStatus,
  connectorStatus,
  type LicenceIssuer,
  STATUS_PATH,
  stockholmToday,
} from "./status.ts";

/**
 * The connector's server entry point.
 *
 * Two routes. `mcp`, which the manifest declares as the instance's OAuth
 * protected resource: the host mounts it at `/api/plugin/mcp-connector/mcp`,
 * makes it accept a Bearer token issued for that address and nothing else,
 * and marks each request it admits with the member and the connected app. The
 * route hands the request to the MCP server as a web-standard request and
 * sends back what it answers. And `status`, which the connector's screen reads
 * on the board's session.
 *
 * The controllers take no constructor arguments: they close over the host
 * object instead. The bundler that builds this file does not emit the
 * metadata NestJS would need to inject one.
 */

/** The manifest's `licence.issuer`, written in by the build. */
declare const LICENCE_ISSUER: LicenceIssuer;

/**
 * The metadata key the host reads a route's required capabilities from.
 *
 * The host's `@RequireCapability` writes it, and the plugin contract lets a
 * plugin's controller require more than its floor that way. The SDK exports
 * no decorator for it, so the key is written here as the host spells it.
 */
const REQUIRED_CAPABILITIES = "openbrf:required-capabilities";

/** The parts of the host's request and reply this route reads and writes. */
interface HostRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body?: unknown;
}

interface HostReply {
  code(status: number): HostReply;
  header(name: string, value: string): HostReply;
  send(payload?: string): unknown;
}

/**
 * Headers the MCP server is not handed.
 *
 * The credentials, because the host has already read them and the server has
 * no use for them. The framing, because the body is handed over parsed and the
 * lengths would describe bytes that are not there.
 */
const WITHHELD_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
]);

export function webRequestFor(request: HostRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || WITHHELD_HEADERS.has(name.toLowerCase())) {
      continue;
    }
    for (const each of Array.isArray(value) ? value : [value]) {
      headers.append(name, each);
    }
  }
  // The origin is never read: the SDK serves the request it is handed and
  // validates no host. A fixed one keeps the instance's own address out of it.
  return new Request(new URL(request.url, "http://connector.invalid"), {
    method: request.method,
    headers,
  });
}

async function send(reply: HostReply, response: Response): Promise<void> {
  reply.code(response.status);
  response.headers.forEach((value, name) => {
    if (name !== "content-length") {
      reply.header(name, value);
    }
  });
  const body = await response.text();
  reply.send(body.length > 0 ? body : undefined);
}

export const createPlugin: PluginModuleFactory = (
  pluginHost: PluginHost,
): DynamicModule => {
  const host = pluginHost as ConnectorHost;

  @Controller()
  class McpController {
    @Post("mcp")
    async post(
      @Req() request: HostRequest,
      @Res() reply: HostReply,
    ): Promise<void> {
      await this.serve(request, reply);
    }

    // 2025-era session operations. Serving is stateless, so the SDK answers
    // both with 405; they are routed rather than left to a 404 so a client is
    // told that rather than that the endpoint is missing.
    @Get("mcp")
    async get(
      @Req() request: HostRequest,
      @Res() reply: HostReply,
    ): Promise<void> {
      await this.serve(request, reply);
    }

    @Delete("mcp")
    async delete(
      @Req() request: HostRequest,
      @Res() reply: HostReply,
    ): Promise<void> {
      await this.serve(request, reply);
    }

    private async serve(request: HostRequest, reply: HostReply): Promise<void> {
      const response = await serveMcp(
        host,
        request,
        webRequestFor(request),
        request.body,
      );
      await send(reply, response);
    }
  }

  /**
   * The licence finding, for the connector's screen.
   *
   * `association:read`, as the instance's plugin list is: the board answers
   * for how the instance is configured, and reads it without being able to
   * change it. The connector declares no permission, so without this its
   * routes are held to `self:manage`, which every resident has.
   *
   * A connected app is refused even with a capability that would admit it.
   * The licence's state and dates are the board's to read, and the MCP route
   * tells a client no more than that a licence is required. A host without
   * `actions.client` cannot say who sent the request, and is answered: the
   * route is behind its session guard all the same, and the screen is what
   * tells the board that such an instance needs updating.
   */
  @Controller(STATUS_PATH)
  @SetMetadata(REQUIRED_CAPABILITIES, ["association:read"])
  class StatusController {
    @Get()
    async get(@Req() request: HostRequest): Promise<ConnectorStatus> {
      const app = connectedApp(host, request);
      if (app !== null && app !== "unknown") {
        throw new ForbiddenException();
      }
      return connectorStatus({
        hostSupported:
          host.entitlements !== undefined &&
          typeof host.actions.client === "function",
        licence: (await host.entitlements?.get()) ?? null,
        today: stockholmToday(new Date()),
        issuer: LICENCE_ISSUER,
      });
    }
  }

  @Module({})
  class McpConnectorModule {}

  return {
    module: McpConnectorModule,
    controllers: [McpController, StatusController],
  };
};
