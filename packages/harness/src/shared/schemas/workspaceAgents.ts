import { Schema } from 'effect';

const AgentKeyListSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

/**
 * One durable description of how a workspace obtains its visible agents.
 * The discriminant keeps inheritance, the complete catalog, named teams, and
 * exact custom selections distinct instead of overloading absent arrays.
 */
export const WorkspaceAgentsSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('inherit') }),
  Schema.Struct({ kind: Schema.Literal('all') }),
  Schema.Struct({
    kind: Schema.Literal('team'),
    teamId: Schema.Trim.check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    kind: Schema.Literal('custom'),
    agentKeys: AgentKeyListSchema,
  }),
]);

/**
 * The decoded shape of {@link WorkspaceAgentsSelectionSchema}: the
 * `texra.workspaceAgents` workspace state.
 */
export type WorkspaceAgentsSelection =
  (typeof WorkspaceAgentsSelectionSchema)['Type'];

/**
 * The custom agents a workspace has hidden. A custom agent is shown unless it
 * is listed here, whatever the workspace agents selection: one the user adds to the
 * custom folder (the `creator` agent's, say) appears in the selector without a
 * separate step, and one the user turned off stays off.
 */
export const HiddenCustomAgentKeysSchema = AgentKeyListSchema;

/**
 * The selection a workspace has until the user chooses one: it inherits the
 * global agents.
 */
export const INHERITED_WORKSPACE_AGENTS: WorkspaceAgentsSelection =
  Object.freeze({
    kind: 'inherit',
  });

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = AgentKeyListSchema;

/**
 * The decoded shape of {@link AgentDelegationScopeSchema}: the agent keys a
 * run's delegation tools may launch, as its config carries them.
 */
export type AgentDelegationScope = typeof AgentDelegationScopeSchema.Type;
