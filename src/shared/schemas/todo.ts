// Third-party imports
import { z } from 'zod';

/** Todo status values - single source of truth for todo item states. */
const todoStatusValues = ['pending', 'in_progress', 'completed'] as const;

/** Todo status constants for programmatic access. */
export const TODO_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const satisfies Record<string, (typeof todoStatusValues)[number]>;

/** Status of a todo item */
export const TodoStatusSchema = z
  .enum(todoStatusValues)
  .describe('Current status of the task');
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

/** Schema for a single todo item (single source of truth for all todo schemas) */
export const TodoItemSchema = z.strictObject({
  /** The task description in imperative form */
  content: z.string().min(1).describe('Task description in imperative form'),
  /** Current status of the task */
  status: TodoStatusSchema,
  /** Present continuous form shown during execution */
  activeForm: z
    .string()
    .min(1)
    .describe('Present continuous form for display during execution'),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;
