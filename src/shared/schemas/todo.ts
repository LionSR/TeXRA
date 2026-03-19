import { z } from 'zod';

import { StreamTabIdSchema } from './identifiers';

const todoStatusValues = ['pending', 'in_progress', 'completed'] as const;

export const TODO_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const satisfies Record<string, (typeof todoStatusValues)[number]>;

export const TodoStatusSchema = z
  .enum(todoStatusValues)
  .describe('Current status of the task');
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.strictObject({
  content: z.string().min(1).describe('Task description in imperative form'),
  status: TodoStatusSchema,
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form for display during execution'),
  /** Optional detailed description (used for plan-style items). */
  description: z.string().nullish(),
  /** Optional list of files involved (used for plan-style items). */
  files: z.array(z.string()).nullish(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const UpdateTodosPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
  /** Optional high-level summary of the task list (replaces Plan.summary). */
  summary: z.string().nullable().optional(),
});
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;
