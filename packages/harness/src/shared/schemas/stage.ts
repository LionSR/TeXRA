import { Schema } from 'effect';

import { RunOutcomeSchema } from './run';

export const StageSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  /** Its first-appearance position among its run's transcript rows
   *  (`TranscriptRowBase.seqNo`), which orders it among them. */
  seqNo: Schema.Int,
  startTime: Schema.Number,
  /** When and with what outcome it closed; null while it is open, when it
   *  reads as its run reads. */
  end: Schema.NullOr(
    Schema.Struct({ outcome: RunOutcomeSchema, at: Schema.Number }),
  ),
});

export type Stage = typeof StageSchema.Type;
