import { Schema } from 'effect';

import { TaskGroupStatusSchema } from './run';

export const StageKindSchema = Schema.Literals(['run', 'session', 'script']);

export const TaskGroupSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.optional(Schema.Number),
  status: TaskGroupStatusSchema,
  parentGroupId: Schema.optional(Schema.String),
  kind: Schema.optional(StageKindSchema),
});

export type TaskGroup = typeof TaskGroupSchema.Type;
