import { Schema } from 'effect';

const AgentKeyListSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

/**
 * How a workspace obtains its visible agents: every agent of the catalog, or
 * an exact list.
 */
export const WorkspaceAgentsSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('all') }),
  Schema.Struct({
    kind: Schema.Literal('custom'),
    agentKeys: AgentKeyListSchema,
  }),
]);

export type WorkspaceAgentsSelection =
  (typeof WorkspaceAgentsSelectionSchema)['Type'];

/**
 * The custom agents a workspace has hidden. A custom agent is shown unless it
 * is listed here, whatever the workspace agents selection: one the user adds to the
 * custom folder (the `creator` agent's, say) appears in the selector without a
 * separate step, and one the user turned off stays off.
 */
export const HiddenCustomAgentKeysSchema = AgentKeyListSchema;

/** The selection of a workspace that stored none: every agent. */
export const ALL_WORKSPACE_AGENTS: WorkspaceAgentsSelection = Object.freeze({
  kind: 'all',
});

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = AgentKeyListSchema;

export type AgentDelegationScope = typeof AgentDelegationScopeSchema.Type;
