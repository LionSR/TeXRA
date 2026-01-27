import { z } from 'zod';

import {
  AddTaskGroupPayloadSchema,
  ExecutionIdSchema,
  StorageKeySchema,
  StreamTabIdSchema,
  UpdateTaskGroupPayloadSchema,
  UpdateTodosPayloadSchema,
} from '@shared/schemas';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { TaskStateSchema, type TaskState } from '@logger/TaskState';

export {
  ProviderErrorPartialSchema,
  RetryRequestPromptSchema,
  ToolEditApprovalPromptSchema,
  WorkflowAgentProposalPromptSchema,
  WorkflowAgentProposalSchema,
  type ProviderErrorPartial,
  type RetryRequestPrompt,
  type TaskGroupStatus,
  type TodoItem,
  type TodoStatus,
  type ToolEditApprovalPrompt,
  type WorkflowAgentProposal,
  type WorkflowAgentProposalPrompt,
} from '@shared/schemas';

export type AddTaskGroupPayload = z.infer<typeof AddTaskGroupPayloadSchema>;
export type UpdateTaskGroupPayload = z.infer<
  typeof UpdateTaskGroupPayloadSchema
>;

export const RunScopedPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  storageKey: StorageKeySchema,
  executionId: ExecutionIdSchema.optional(),
});
export type RunScopedPayload = z.infer<typeof RunScopedPayloadSchema>;

export { TODO_STATUS } from '@shared/schemas';
export type UpdateTodosPayload = z.infer<typeof UpdateTodosPayloadSchema>;

export const SetActiveStreamPayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema.nullable(),
  agentCategory: z.enum(AgentCategory).optional(),
  /** Hint whether this is a remote agent (for UI display before TaskState is set) */
  isRemote: z.boolean().optional(),
  /** Hint whether this agent uses multiple outputs (for UI display before TaskState is set) */
  hasMultipleOutputs: z.boolean().optional(),
});
export type SetActiveStreamPayload = z.infer<
  typeof SetActiveStreamPayloadSchema
>;

export const SetTaskStatePayloadSchema = z.strictObject({
  streamId: StreamTabIdSchema,
  executionId: ExecutionIdSchema.optional(),
  taskState: TaskStateSchema.transform((v): TaskState => v as TaskState),
});
export type SetTaskStatePayload = z.infer<typeof SetTaskStatePayloadSchema>;
