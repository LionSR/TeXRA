import { Schema } from 'effect';

import { RunOutcomeSchema } from './run';

export const StageKindSchema = Schema.Literals(['run', 'session', 'script']);

export const StageSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.optional(Schema.Number),
  /** The outcome it closed with; null while it is open, when it reads as
   *  its run reads. */
  outcome: Schema.NullOr(RunOutcomeSchema),
  kind: Schema.optional(StageKindSchema),
});

export type Stage = typeof StageSchema.Type;
