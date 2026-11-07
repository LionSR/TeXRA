/**
 * The `log-usage-v2` wire: exactly what a current client sends
 * (`UsageLogEntry`, `packages/harness/src/shared/usageLog.ts`), checked here
 * at its boundary. `provider` and `usageRoute` are plain strings stored
 * verbatim: the columns are an external contract versioned with this
 * function, so a client's new route is a new value, not a rejected batch.
 */

import { Schema } from 'effect';

const NonnegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** A UTC ISO 8601 date-time, as the client's `DateTime.formatIso` writes it. */
const UtcDateTime = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/, {
    expected: 'a UTC ISO 8601 date-time',
  }),
);

const UsageEntrySchema = Schema.Struct({
  timestamp: UtcDateTime,
  /** The catalog id, before any route's rewrite. */
  model: Schema.String,
  provider: Schema.String,
  agentName: Schema.optional(Schema.String),
  usageRoute: Schema.optional(Schema.String),
  streamId: Schema.optional(Schema.String),
  /** Cache-miss input tokens; the cache reads are `cachedInputTokens`. */
  inputTokens: NonnegativeInt,
  outputTokens: NonnegativeInt,
  /** The call's cost at list prices, which the client computed: on a plan
   *  route, what the subscription covered. */
  listCost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  responseTimeMs: Schema.optional(NonnegativeInt),
  cachedInputTokens: Schema.optional(NonnegativeInt),
  reasoningTokens: Schema.optional(NonnegativeInt),
  extensionVersion: Schema.optional(Schema.String),
  editorType: Schema.optional(Schema.String),
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
