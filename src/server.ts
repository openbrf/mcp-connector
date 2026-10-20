import {
  Controller,
  Delete,
  type DynamicModule,
  Get,
  Module,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { PluginHost, PluginModuleFactory } from "@openbrf/plugin-sdk";

import { serveMcp } from "./connector.ts";
import type { ConnectorHost } from "./host-contract.ts";

/**
 * The connector's server entry point.
 *
 * One route, `mcp`, which the manifest declares as the instance's OAuth
 * protected resource. The host mounts it at `/api/plugin/mcp-connector/mcp`,
 * makes it accept a Bearer token issued for that address and nothing else,
 * and marks each request it admits with the member and the connected app. The
 * route hands the request to the MCP server as a web-standard request and
 * sends back what it answers.
 *
 * The controller takes no constructor arguments: it closes over the host
 * object instead. The bundler that builds this file does not emit the
 * metadata NestJS would need to inject one.
 */

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

  @Module({})
  class McpConnectorModule {}

  return {
    module: McpConnectorModule,
    controllers: [McpController],
  };
};
