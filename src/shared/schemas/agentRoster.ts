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

export const INHERITED_AGENT_ROSTER: AgentRosterSelection = Object.freeze({
  kind: 'inherit',
});

/** Canonical delegation catalog shape: agent keys keyed by category. */
const AgentDelegationScopeCanonicalSchema = z.record(
  AgentCategorySchema,
  AgentKeyListSchema,
);

/**
 * Legacy persisted shape: team-run `config.json` rows written before the
 * category-keyed record (#8403 era) carried the scope as a
 * `workflowAgentKeys`/`toolUseAgentKeys` field pair. Normalized once, here at
 * the parse boundary — dropping this member would fail AgentConfigSchema on
 * those rows and list finished team runs as incomplete.
 *
 * Introduced 2026-08-04 (#9705). Permanent parse-side reader, not a dated
 * migration: the pair lives in immutable per-run history rows that are never
 * rewritten, so there is no rewrite event to retire on. Retires only with a
 * policy decision to stop reading pre-record run history.
 */
export const AgentDelegationScopeLegacySchema = z
  .strictObject({
    workflowAgentKeys: AgentKeyListSchema,
    toolUseAgentKeys: AgentKeyListSchema,
  })
  .transform(({ workflowAgentKeys, toolUseAgentKeys }) => ({
    [AgentCategory.Workflow]: workflowAgentKeys,
    [AgentCategory.ToolUse]: toolUseAgentKeys,
  }));

/** Exact delegation catalog attached to a run, independent of durable UI state. */
export const AgentDelegationScopeSchema = z.union([
  AgentDelegationScopeCanonicalSchema,
  AgentDelegationScopeLegacySchema,
]);

export type AgentDelegationScope = z.infer<
  typeof AgentDelegationScopeCanonicalSchema
>;
