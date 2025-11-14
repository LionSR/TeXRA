// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import {
  AgentSharedStoreSnapshotSchema,
  type AgentSharedStoreSnapshot,
} from '@agent/core/AgentSharedStore';
// Type imports
import type { AgentSharedStore } from '@agent/core/AgentSharedStore';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

export const TOOL_USE_SNAPSHOT_VERSION = 1;

const ProviderMessageSchema = z.custom<ProviderMessage>(
  (value): value is ProviderMessage =>
    typeof value === 'object' && value !== null,
  {
    error: 'messages must contain provider message objects',
  },
);

export const ToolUseSessionSnapshotSchema = z.strictObject({
  version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
  executionId: z.string(),
  streamId: z.string(),
  agentConfig: AgentConfigSchema,
  messages: z.array(ProviderMessageSchema),
  store: AgentSharedStoreSnapshotSchema,
  lastUpdated: z.number(),
});

export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

export interface SaveToolUseSnapshotPayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentConfig: AgentConfig;
  messages: ProviderMessage[];
  store: AgentSharedStore;
}

// Legacy normalization removed; snapshots must conform to the strict schema.
