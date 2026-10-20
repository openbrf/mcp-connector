import type { Tool, ToolAnnotations } from "@modelcontextprotocol/server";

import type { ActionDescription } from "./host-contract.ts";

/**
 * One action as an MCP tool.
 *
 * The name is the action's own: the registry already holds every name to what
 * an MCP tool name allows. The title and description are the ones the
 * registry resolved into the instance's language, which is what a model and
 * the person approving its call both read.
 */
export function toolFor(action: ActionDescription): Tool {
  return {
    name: action.name,
    title: action.title,
    description: action.description,
    // As the host publishes them: JSON Schema draft 2020-12, which is also
    // MCP's dialect, with `$schema` kept (SEP-1613).
    inputSchema: action.inputSchema as Tool["inputSchema"],
    outputSchema: action.outputSchema as Tool["outputSchema"],
    annotations: annotationsFor(action),
  };
}

/**
 * The four hints a client decides with whether to ask the person first.
 *
 * The mapping is the one `docs/actions.md` in openbrf/openbrf publishes. Two
 * of the hints default to true in MCP, so an action that says nothing about
 * itself would read as destroying something and reaching outside the
 * instance: every hint is therefore stated, never left out.
 */
export function annotationsFor(action: ActionDescription): ToolAnnotations {
  return {
    title: action.title,
    readOnlyHint: action.effect === "read",
    idempotentHint: action.idempotent,
    openWorldHint: action.openWorld,
    destructiveHint:
      action.needsConfirmation ||
      (action.effect !== "read" && !action.additive),
  };
}
