import { z } from 'zod';

export const TODO_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

const TodoStatusSchema = z
  .enum(TODO_STATUS)
  .describe('Current status of the task');
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const TodoItemSchema = z.strictObject({
  content: z.string().min(1).describe('Task description in imperative form'),
  status: TodoStatusSchema,
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form for display during run'),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;
