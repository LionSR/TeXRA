import { Schema } from 'effect';

/** Exact delegation catalog attached to a run. */
export const AgentDelegationScopeSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

export type AgentDelegationScope = typeof AgentDelegationScopeSchema.Type;
