import { Schema } from 'effect';

import { RunOutcomeSchema } from './run';

export const StageSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  /** Its first-appearance position among its run's transcript rows
   *  (`TranscriptRowBase.seqNo`), which orders it among them. */
  seqNo: Schema.Int,
  startTime: Schema.Number,
  endTime: Schema.optional(Schema.Number),
  /** The outcome it closed with; null while it is open, when it reads as
   *  its run reads. */
  outcome: Schema.NullOr(RunOutcomeSchema),
});

export type Stage = typeof StageSchema.Type;
