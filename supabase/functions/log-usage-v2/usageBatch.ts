/**
 * The `log-usage-v2` wire, checked here at its boundary. The client checks
 * each entry against its own schema before sending
 * (`UsageLogEntrySchema`, `packages/harness/src/shared/usageLog.ts`), and the
 * two must match: everything that one accepts, this one accepts. `provider`
 * and `usageRoute` are non-empty strings stored verbatim: the columns are an
 * external contract versioned with this function, so a client's new route
 * is a new value, not a rejected batch.
 */

import { Schema } from 'effect';

const NonnegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.String.check(Schema.isMinLength(1));

/** A UTC ISO 8601 date-time, as the client's `DateTime.formatIso` writes it. */
const UtcDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    expected: 'a UTC ISO 8601 date-time',
  }),
);

const UsageEntrySchema = Schema.Struct({
  timestamp: UtcDateTime,
  /** The catalog id, before any route's rewrite. */
  model: Text,
  provider: Text,
  agentName: Schema.optional(Text),
  usageRoute: Schema.optional(Text),
  streamId: Schema.optional(Text),
  /** Cache-miss input tokens; the cache reads are `cachedInputTokens`. */
  inputTokens: NonnegativeInt,
  outputTokens: NonnegativeInt,
  /** The call's cost at list prices, which the client computed: on a plan
   *  route, what the subscription covered. */
  listCost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  responseTimeMs: Schema.optional(NonnegativeInt),
  cachedInputTokens: Schema.optional(NonnegativeInt),
  reasoningTokens: Schema.optional(NonnegativeInt),
  extensionVersion: Schema.optional(Text),
  editorType: Schema.optional(Text),
});

export const UsageBatchSchema = Schema.Struct({
  // The client drains at most its 1000-entry queue per flush, and callers
  // are anonymous, so a batch is bounded at that size.
  entries: Schema.Array(UsageEntrySchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1000),
  ),
  batchId: Schema.String.check(Schema.isUUID()),
});

export type UsageBatch = typeof UsageBatchSchema.Type;
