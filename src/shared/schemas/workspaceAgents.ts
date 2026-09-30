import { z } from 'zod';

import { AgentCategorySchema } from './agent';

const AgentKeyListSchema = z.array(z.string().trim().min(1));
const WorkspaceAgentsCategorySelectionSchema = z.union([
  z.literal('all'),
  AgentKeyListSchema,
]);
export type WorkspaceAgentsCategorySelection = z.infer<
  typeof WorkspaceAgentsCategorySelectionSchema
>;

/**
 * One durable description of how a workspace obtains its visible agents.
 * The discriminant keeps inheritance, the complete catalog, named teams, and
 * exact custom selections distinct instead of overloading absent arrays.
 */
export const WorkspaceAgentsSelectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inherit') }),
  z.strictObject({ kind: z.literal('all') }),
  z.strictObject({
    kind: z.literal('team'),
    teamId: z.string().trim().min(1),
  }),
  z.strictObject({
    kind: z.literal('custom'),
    agentKeys: z.record(
      AgentCategorySchema,
      WorkspaceAgentsCategorySelectionSchema,
    ),
  }),
]);

export type WorkspaceAgentsSelection = z.infer<
  typeof WorkspaceAgentsSelectionSchema
>;

/**
 * The custom agents a workspace has hidden. A custom agent is shown unless it
 * is listed here, whatever the workspace agents selection: one the user adds to the
 * custom folder (the `creator` agent's, say) appears in the selector without a
 * separate step, and one the user turned off stays off.
 */
export const HiddenCustomAgentKeysSchema = AgentKeyListSchema;

export const INHERITED_WORKSPACE_AGENTS: WorkspaceAgentsSelection =
  Object.freeze({
    kind: 'inherit',
  });

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = z.record(
  AgentCategorySchema,
  AgentKeyListSchema,
);

export type AgentDelegationScope = z.infer<typeof AgentDelegationScopeSchema>;
