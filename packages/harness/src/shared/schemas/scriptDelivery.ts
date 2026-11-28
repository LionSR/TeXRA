import { Schema } from 'effect';

import { NonNegativeIntSchema } from './nonNegativeInt';

/** How a background script's calls ended, by outcome: every call counts
 *  under one. */
const ScriptTallySchema = Schema.Struct({
  ok: NonNegativeIntSchema,
  failed: NonNegativeIntSchema,
  cancelled: NonNegativeIntSchema,
  /** Skipped by the user. */
  skipped: NonNegativeIntSchema,
});
export type ScriptTally = typeof ScriptTallySchema.Type;

/** Compact, host-neutral facts used to present a background script's
 *  delivery. */
export const ScriptDeliverySummarySchema = Schema.Struct({
  name: Schema.String,
  outcome: Schema.Literals(['completed', 'failed', 'stopped']),
  sectionCount: NonNegativeIntSchema,
  tally: ScriptTallySchema,
  costUsd: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMs: NonNegativeIntSchema,
  /** The files the script's calls wrote, each once, by workspace path. */
  files: Schema.Array(Schema.String),
  errorCause: Schema.NullOr(Schema.String),
});

export type ScriptDeliverySummary = typeof ScriptDeliverySummarySchema.Type;
