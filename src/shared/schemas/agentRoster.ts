import { z } from 'zod';

import { AgentCategory, AgentCategorySchema } from './agent';

const AgentKeyListSchema = z.array(z.string().trim().min(1));
const AgentRosterCategorySelectionSchema = z.union([
  z.literal('all'),
  AgentKeyListSchema,
]);
export type AgentRosterCategorySelection = z.infer<
  typeof AgentRosterCategorySelectionSchema
>;

/**
 * One durable description of how a workspace obtains its visible agents.
 * The discriminant keeps inheritance, the complete catalog, named teams, and
 * exact custom selections distinct instead of overloading absent arrays.
 */
export const AgentRosterSelectionSchema = z.discriminatedUnion('kind', [
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
      AgentRosterCategorySelectionSchema,
    ),
  }),
]);

export type AgentRosterSelection = z.infer<typeof AgentRosterSelectionSchema>;

/**
 * v1 persisted shape: the `custom` member carried the roster as a
 * `workflowAgentKeys`/`toolUseAgentKeys` field pair. Normalized to the
 * category-keyed record once, at the persistence entrance — new writes go to
 * the versioned v2 key and never take this branch.
 */
const AgentRosterSelectionV1CustomSchema = z
  .strictObject({
    kind: z.literal('custom'),
    workflowAgentKeys: AgentRosterCategorySelectionSchema,
    toolUseAgentKeys: AgentRosterCategorySelectionSchema,
  })
  .transform(({ workflowAgentKeys, toolUseAgentKeys }) => ({
    kind: 'custom' as const,
    agentKeys: {
      [AgentCategory.Workflow]: workflowAgentKeys,
      [AgentCategory.ToolUse]: toolUseAgentKeys,
    },
  }));

/** Reader for the unversioned v1 state key (legacy entrance only). */
export const AgentRosterSelectionV1Schema = z.union([
  AgentRosterSelectionSchema,
  AgentRosterSelectionV1CustomSchema,
]);

export const INHERITED_AGENT_ROSTER: AgentRosterSelection = Object.freeze({
  kind: 'inherit',
});

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = z.record(
  AgentCategorySchema,
  AgentKeyListSchema,
);

export type AgentDelegationScope = z.infer<typeof AgentDelegationScopeSchema>;
