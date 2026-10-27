import { Schema } from 'effect';

import { LineCountSchema } from './lineChanges';

/** How a background script's calls ended. */
const ScriptTallySchema = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ok: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  failed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cancelled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Skipped by the user. */
  skipped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/**
 * The decoded shape of the tally: how many of a background script's calls
 * ended ok, failed, were cancelled or were skipped.
 */
export type ScriptTally = typeof ScriptTallySchema.Type;

/** A file the script's calls wrote, by the workspace path it replaces, with
 *  its line counts summed over the calls that wrote it (null once a call
 *  reported none). */
const ScriptDeliveryFileSchema = Schema.Struct({
  path: Schema.String,
  added: Schema.NullOr(LineCountSchema),
  removed: Schema.NullOr(LineCountSchema),
});

/** Compact, host-neutral facts used to present a background script's
 *  delivery. */
export const ScriptDeliverySummarySchema = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(['completed', 'failed', 'stopped']),
  phaseCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  tally: ScriptTallySchema,
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  files: Schema.Array(ScriptDeliveryFileSchema),
  errorCause: Schema.NullOr(Schema.String),
});

/** The decoded shape of {@link ScriptDeliverySummarySchema}. */
export type ScriptDeliverySummary = typeof ScriptDeliverySummarySchema.Type;
