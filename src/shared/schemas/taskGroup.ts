import { z } from 'zod';

import { TaskGroupStatusSchema } from './stream';

export const TaskGroupSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string(),
  startTime: z.number(),
  endTime: z.number().optional(),
  status: TaskGroupStatusSchema,
  parentGroupId: z.string().optional(),
  kind: z.enum(['run', 'round', 'phase', 'session']).optional(),
  index: z.int().nonnegative().optional(),
  total: z.int().positive().optional(),
});

export type TaskGroup = z.infer<typeof TaskGroupSchema>;
