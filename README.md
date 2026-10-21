# MCP Connector for Open BRF

An [Open BRF](https://github.com/openbrf/openbrf) plugin that lets an MCP client,
such as a chat assistant, act as a signed-in member of a housing cooperative.
The client reaches the instance only through its **actions**: what the member
could already do, offered to connected apps by the instance's administrator one
action at a time.

The connector holds no permission of its own. It declares no data permission and
no personal data, and registers no action. Everything a client can do is an action
the instance's registry offers that member, on the `mcp` surface, at the moment of
the call.

## How it works

- **The route.** The manifest declares `oauthProtectedResource: "mcp"`. The host
  mounts the route at `/api/plugin/mcp-connector/mcp` and makes that address the
  audience of every token it issues to a connected app. The route accepts a
  Bearer token issued for it and nothing else (ADR 0009 in openbrf/openbrf).
  Signing in, consent, scopes and revoking an app are all the host's. The
  connector also refuses a request the host admitted on the browser's session,
  which can happen only when another plugin holds the instance's protected
  resource. It asks `host.actions.client(request)` which connected app the host
  authenticated the request for, and answers `403` when there is none.
- **Tools.** `tools/list` is `host.actions.list(request)`: the actions the
  registry offers this member through this app, each with its JSON Schema
  (draft 2020-12, as the host publishes it). The four MCP hints follow the
  mapping in `docs/actions.md` in openbrf/openbrf. Nothing is cached, so
  disarming an action, a capability the member loses and a revoked app all
  take effect on the next request.
- **Calls.** `tools/call` is `host.actions.invoke(request, name, arguments)`.
  The host decides who is acting, on which channel, and whether the call is
  allowed. A refusal is rendered the way the host's refusal table says: as a
  tool result with `isError` set that carries the reason, the retry verdict and
  the particulars, or as a JSON-RPC error when the call never happened. A token
  without the scope a call needs is answered `403` with the host's
  `WWW-Authenticate` challenge, so the client can ask the member for it.
- **Protocol.** Stateless Streamable HTTP, built on the MCP TypeScript SDK v2.
  It serves the 2026-07-28 revision, and 2025-era clients through the SDK's
  stateless fallback. Sessions and server-sent event streams are not offered:
  `GET` and `DELETE` are answered `405`.
- **Errors.** A listing or a call that fails other than by a refusal is
  answered as a JSON-RPC internal error with a sentence of the connector's own,
  never with what the host threw. The connector's sentences are in `locales/`,
  in English when the request's `Accept-Language` puts English first and in
  Swedish otherwise. A client acts on `data.reason`, not on the sentence.

## Licence

The MCP Connector is a paid module. It reads the instance's licence through
`host.entitlements` (ADR 0042 in openbrf/openbrf). The licence is a signed file
the board enters on the instance's licence screen and the host verifies offline.
The licence for the AI package includes the connector.

Without an active `mcp-connector` entitlement the connector is **dormant**. The
host still authenticates every request as usual, so a caller without a valid
token gets the same `401` either way. A client with a valid token gets a JSON-RPC
error with code `-32050` and `data.reason` `entitlement-required` for every
request, with no dates or licence details. The connector lists no tools and makes
no calls. Nothing is switched off: once a licence is entered, the connector
serves again as it did before.

A host that does not yet have `host.entitlements` cannot tell a licensed instance
from an unlicensed one, so the connector stays dormant there too. A host whose
`host.actions.list` entries carry no `inputSchema` and `outputSchema` is
answered with `data.reason` `host-unsupported` to `tools/list` and `tools/call`;
`initialize` and `ping` still work. An empty listing cannot be told apart from
one such a host gives, and offers no tools either way. A host without
`host.actions.client` cannot say whether a connected app sent a request, so
every `POST` there is answered with `host-unsupported`, `initialize` included.

The issuer key in `package.json` is a placeholder whose private half was never
kept. No licence verifies against it until Apteo's issuing key replaces it.

The code is licensed under the [AGPL-3.0](LICENSE).

## The connector's screen

The connector's view, at `/app/plugin/mcp-connector`, is offered in the board's
section of the navigation. It shows three things:

- **The licence.** The host's finding, with the dates and the licence id it
  carries. From thirty days before an active licence ends, the screen says how
  many days are left, counted on the Stockholm calendar day the host judges a
  licence by. Without an active licence it says the connector is dormant, that
  the board enters a licence on the instance's licence screen, and links to the
  issuer the manifest names. On a host without `host.entitlements` or
  `host.actions.client` it asks for the instance to be updated.
- **The address for MCP clients.** The `resource` in the instance's
  `/.well-known/oauth-protected-resource`, which is the address every token is
  issued for. If another plugin holds the instance's protected resource, the
  screen says so rather than show an address that reaches that plugin.
- **What connected apps may do.** Links to the armed actions on the core's
  plugins screen and to the connected apps.

The view reads the licence from the connector's own route,
`GET /api/plugin/mcp-connector/status`. The route requires `association:read`,
the board's reading of how the instance is configured, and refuses a connected
app: a client is told no more than that a licence is required.

## Development

```sh
pnpm install
pnpm test            # builds dist/server.cjs and runs the conformance tests
pnpm typecheck
pnpm build && pnpm check:package
```

`pnpm test` loads the bundle this package ships into a NestJS application on
Fastify, behind a stand-in for the host's Bearer gate, action registry and
licence. It connects three MCP clients to it over HTTP: the SDK v2 client on
2026-07-28, the same client on the 2025 handshake, and the SDK v1 client. It
also runs the MCP project's conformance runner on the scenarios that apply to
any server. The view is rendered into a DOM with the connector's translations,
against stand-ins for the two documents it reads.

`pnpm build` builds the view first, with Vite, as the Module Federation remote
`dist/remoteEntry.js`. React, ReactDOM, i18next and react-i18next are shared
singletons, the host's own copies.

The server entry point is one CommonJS bundle, `dist/server.cjs`. The MCP SDK is
bundled into it. Its only externals are `@nestjs/common`, `zod` and Node's
built-ins, the packages the host shares. `pnpm check:package` runs the SDK's
`pluginPackageProblems` over the packed tarball, as the catalog does before it
lists a release.

Every dependency is pinned to an exact version. The MCP SDK changes with the
specification, so upgrade it deliberately and run the conformance tests.

### Host members newer than the SDK release

The connector builds against `@openbrf/plugin-sdk` 1.0.0. The schemas on a `host.actions.list` entry,
`host.actions.client`, `host.entitlements` and the shape of an `ActionRefusal`
came later.
`src/host-contract.ts` declares them as the SDK does, and the connector checks for
each one at run time, because an older host does not have it. Replace those
declarations with the SDK's own exports once a release carries them.

## Contributing

Contributions are welcome under the
[Open BRF contributor licence agreement](https://github.com/openbrf/openbrf/blob/main/CLA.md).
Commit messages and pull request titles follow
[Conventional Commits](https://www.conventionalcommits.org/).
