// Third-party imports
import { z } from 'zod';

// Local imports
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
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

export const UpdateTodosPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  todos: z.array(TodoItemSchema),
});
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;
