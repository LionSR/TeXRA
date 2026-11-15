import { Schema } from 'effect';

import { NonNegativeIntSchema } from './nonNegativeInt';

/** How a background script's calls ended. */
const ScriptTallySchema = Schema.Struct({
  total: NonNegativeIntSchema,
  ok: NonNegativeIntSchema,
  failed: NonNegativeIntSchema,
  cancelled: NonNegativeIntSchema,
  /** Skipped by the user. */
  skipped: NonNegativeIntSchema,
});
export type ScriptTally = typeof ScriptTallySchema.Type;

/** A file the script's calls wrote, by the workspace path it replaces, with
 *  its line counts summed over the calls that wrote it (null once a call
 *  reported none). */
const ScriptDeliveryFileSchema = Schema.Struct({
  path: Schema.String,
  added: Schema.NullOr(NonNegativeIntSchema),
  removed: Schema.NullOr(NonNegativeIntSchema),
});

/** Compact, host-neutral facts used to present a background script's
 *  delivery. */
export const ScriptDeliverySummarySchema = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(['completed', 'failed', 'stopped']),
  sectionCount: NonNegativeIntSchema,
  tally: ScriptTallySchema,
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: NonNegativeIntSchema,
  files: Schema.Array(ScriptDeliveryFileSchema),
  errorCause: Schema.NullOr(Schema.String),
});

export type ScriptDeliverySummary = typeof ScriptDeliverySummarySchema.Type;
