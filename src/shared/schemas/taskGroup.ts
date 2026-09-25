import { z } from 'zod';

import { TaskGroupStatusSchema } from './run';

export const StageKindSchema = z.enum(['run', 'round', 'phase', 'session']);

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
  kind: StageKindSchema.optional(),
  /** Workflow-script projection attempt that opened this phase. */
  attemptId: z.string().min(1).optional(),
  index: z.int().nonnegative().optional(),
  total: z.int().positive().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;
