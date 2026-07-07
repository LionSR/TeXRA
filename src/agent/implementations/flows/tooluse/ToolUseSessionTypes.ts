import { z } from 'zod';

import { AgentConfigSchema } from '@agent/core/definition/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/state/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/state/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/definition/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { ModelHandlerCompatibilityKeySchema } from '@agent/runtime/modelHandlerCompatibilityKey';
import { ExecutionIdSchema, StreamTabIdSchema } from '@shared/schemas';

export const TOOL_USE_SNAPSHOT_VERSION = 2;

export const ToolUseSessionSnapshotSchema = z.strictObject({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  parentStreamId: StreamTabIdSchema.nullish(),
  agentConfig: AgentConfigSchema,
  modelHandlerCompatibilityKey: ModelHandlerCompatibilityKeySchema.nullish(),
  messages: z.array(ProviderMessageSchema),
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
  lastUpdated: z.int().nonnegative(),
});

export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;
