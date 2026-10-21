import type {
  ActionRequest,
  ActionSummary,
  PluginHost,
} from "@openbrf/plugin-sdk";

/**
 * The parts of the host this connector reads that are newer than the plugin
 * SDK release it builds against.
 *
 * Each is written as the SDK declares it in `openbrf/openbrf`, and each is
 * read as optional: a host older than the member answers without it, and the
 * connector has to tell that host apart rather than fail on a missing method.
 * Replace each with the SDK's own export once a release carries it.
 */

/** `ActionWithSchemas`: what `host.actions.list` answers for one action. */
export interface ActionWithSchemas extends ActionSummary {
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema: Record<string, unknown>;
}

/** `EntitlementState`: the host's finding on this plugin's licence (ADR 0042). */
export type EntitlementState =
  | {
      status: "active";
      licenceId: string;
      validUntil: string | null;
      updatesUntil: string | null;
    }
  | { status: "absent" }
  | { status: "expired"; licenceId: string; validUntil: string }
  | {
      status: "version-not-covered";
      licenceId: string;
      updatesUntil: string;
      released: string;
    }
  | { status: "wrong-instance"; licenceId: string }
  | { status: "tampered" }
  | { status: "not-yet-valid"; licenceId: string; issuedOn: string };

/** `PluginEntitlements`: the part of it this connector reads. */
export interface PluginEntitlements {
  get(): Promise<EntitlementState>;
}

/** How a connector renders a refusal: as a protocol error or a tool result. */
export type ActionRefusalTransport = "protocol" | "tool-result";

/** Whether trying again could work, and after what. */
export type ActionRetry = "never" | "after-edit" | "after-backoff";

/** `ActionRefusal`: what `host.actions.invoke` rejects with when refused. */
export interface ActionRefusal extends Error {
  readonly name: "ActionRefusal";
  readonly kind: "registry" | "invalid-body" | "domain";
  readonly reason: string;
  readonly status: number;
  readonly transport: ActionRefusalTransport;
  readonly retry: ActionRetry;
  details(): Record<string, readonly unknown[]>;
  readonly challenge?: string;
}

/**
 * Whether `invoke` was refused rather than failed.
 *
 * Read by its shape, as the SDK's own `isActionRefusal` does, because the host
 * builds the refusal and this bundle's classes are not the host's. Anything
 * that does not match is a fault, answered as an internal error.
 */
export function isActionRefusal(value: unknown): value is ActionRefusal {
  if (!(value instanceof Error) || value.name !== "ActionRefusal") {
    return false;
  }
  const refusal = value as Error &
    Partial<Record<keyof ActionRefusal, unknown>>;
  return (
    typeof refusal.reason === "string" &&
    typeof refusal.status === "number" &&
    typeof refusal.details === "function" &&
    (refusal.transport === "protocol" || refusal.transport === "tool-result") &&
    (refusal.retry === "never" ||
      refusal.retry === "after-edit" ||
      refusal.retry === "after-backoff") &&
    (refusal.challenge === undefined || typeof refusal.challenge === "string")
  );
}

/** `ActionClient`: the connected app a request was authenticated with. */
export interface ActionClient {
  readonly clientId: string;
  readonly clientHost: string | null;
}

/** `PluginActions`, with `client` where the host has it. */
export type ConnectorActions = PluginHost["actions"] & {
  readonly client?: (request: ActionRequest) => ActionClient | null;
};

/** The host object, with the members above where the host has them. */
export type ConnectorHost = Omit<PluginHost, "actions"> & {
  readonly actions: ConnectorActions;
  readonly entitlements?: PluginEntitlements;
};

/**
 * The actions the registry offers this request, each with its schemas, or
 * null on a host that lists none.
 *
 * `list` is older than the schemas on its entries, so a host from before them
 * answers entries without `inputSchema` and `outputSchema`. That cannot be
 * seen on an empty listing, which has nothing to build a tool from either
 * way. Entries are checked one by one rather than the first alone, so a
 * listing the host half-fills is refused too.
 */
export async function listWithSchemas(
  host: ConnectorHost,
  request: ActionRequest,
): Promise<ActionWithSchemas[] | null> {
  const listed: ActionSummary[] = await host.actions.list(request);
  return listed.every(hasSchemas) ? listed : null;
}

function hasSchemas(action: ActionSummary): action is ActionWithSchemas {
  const { inputSchema, outputSchema } = action as Partial<ActionWithSchemas>;
  return isObject(inputSchema) && isObject(outputSchema);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
