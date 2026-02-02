import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';
import { TaskGroupStatusSchema } from './stream';

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;

export const AddTaskGroupPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  ...TaskGroupSchema.shape,
});
export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;

export const UpdateTaskGroupPayloadSchema = AddTaskGroupPayloadSchema.pick({
  streamId: true,
  id: true,
  status: true,
  endTime: true,
});
export type UpdateTaskGroupPayload = z.infer<
  typeof UpdateTaskGroupPayloadSchema
>;
