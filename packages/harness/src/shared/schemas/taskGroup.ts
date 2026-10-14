import { z } from 'zod';

import { TaskGroupStatusSchema } from './run';

export const StageKindSchema = z.enum(['run', 'session', 'script']);

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
  kind: StageKindSchema.optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;
