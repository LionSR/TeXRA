import { z } from 'zod';

import { AgentConfigSchema } from '@agent/core/AgentConfig';
import { AgentRunStateSnapshotSchema } from '@agent/core/AgentState';
import { AgentWorkspaceStateSnapshotSchema } from '@agent/core/AgentWorkspaceState';
import { UserVariableChannelsSchema } from '@agent/core/AgentCycleOptions';
import { ProviderMessageSchema } from '@agent/modelHandlers/types/ProviderMessage';
import { ExecutionIdSchema, StreamTabIdSchema } from '@shared/schemas';

export const TOOL_USE_SNAPSHOT_VERSION = 2;

export const ToolUseSessionSnapshotSchema = z.strictObject({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  executionId: ExecutionIdSchema,
  streamId: StreamTabIdSchema,
  agentConfig: AgentConfigSchema,
  messages: z.array(ProviderMessageSchema),
  run: AgentRunStateSnapshotSchema,
  workspace: AgentWorkspaceStateSnapshotSchema,
  user: UserVariableChannelsSchema,
  lastUpdated: z.int().nonnegative(),
});

export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;
