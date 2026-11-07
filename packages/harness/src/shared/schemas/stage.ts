import { Schema } from 'effect';

import { StageStatusSchema } from './run';

export const StageKindSchema = Schema.Literals(['run', 'session', 'script']);

export const StageSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.optional(Schema.Number),
  status: StageStatusSchema,
  parentStageId: Schema.optional(Schema.String),
  kind: Schema.optional(StageKindSchema),
});

export type Stage = typeof StageSchema.Type;
