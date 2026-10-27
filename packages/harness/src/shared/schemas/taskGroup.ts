import { Schema } from 'effect';

import { TaskGroupStatusSchema } from './run';

/**
 * What a transcript stage groups: a `run`'s own turns, a `session`-level
 * stage, or a background `script`'s calls. A `stage.start` row may carry it so
 * the transcript can draw the group accordingly.
 */
export const StageKindSchema = Schema.Literals(['run', 'session', 'script']);

/**
 * A stage of a run as the session view lists it: its id, name, start and end
 * times, status, the stage it nests under, and what kind of stage it is. The
 * fold builds one from a `stage.start` row and closes it on its `stage.end`.
 */
export const TaskGroupSchema = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1)),
  name: Schema.String,
  startTime: Schema.Number,
  endTime: Schema.optional(Schema.Number),
  status: TaskGroupStatusSchema,
  parentGroupId: Schema.optional(Schema.String),
  kind: Schema.optional(StageKindSchema),
});

/** The decoded shape of {@link TaskGroupSchema}. */
export type TaskGroup = typeof TaskGroupSchema.Type;
