import { z } from 'zod';

const AgentKeyListSchema = z.array(z.string().trim().min(1));

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
    workflowAgentKeys: AgentKeyListSchema,
    toolUseAgentKeys: AgentKeyListSchema,
  }),
]);

export type AgentRosterSelection = z.infer<typeof AgentRosterSelectionSchema>;

export const INHERITED_AGENT_ROSTER: AgentRosterSelection = Object.freeze({
  kind: 'inherit',
});

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = z.strictObject({
  workflowAgentKeys: AgentKeyListSchema,
  toolUseAgentKeys: AgentKeyListSchema,
});

export type AgentDelegationScope = z.infer<typeof AgentDelegationScopeSchema>;
