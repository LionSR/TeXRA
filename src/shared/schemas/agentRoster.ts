import { z } from 'zod';

import { AgentCategorySchema } from './agent';

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

export const INHERITED_AGENT_ROSTER: AgentRosterSelection = Object.freeze({
  kind: 'inherit',
});

/** Canonical delegation catalog shape: agent keys keyed by category. */
const AgentDelegationScopeCanonicalSchema = z.record(
  AgentCategorySchema,
  AgentKeyListSchema,
);

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = AgentDelegationScopeCanonicalSchema;

export type AgentDelegationScope = z.infer<
  typeof AgentDelegationScopeCanonicalSchema
>;
