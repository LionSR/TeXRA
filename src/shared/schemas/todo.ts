import { z } from 'zod';

import type { StreamTabId } from './identifiers';

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
    .describe('Present continuous form for display during execution'),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

/**
 * Payload for a todo update. Declared as a plain type, not a schema: nothing
 * ever parses it — producers build the shape and consumers read it — so a Zod
 * schema would own no boundary (same rule as `UpdatePlanPayload` in `plan.ts`).
 */
export interface UpdateTodosPayload {
  streamId: StreamTabId;
  todos: TodoItem[];
}
