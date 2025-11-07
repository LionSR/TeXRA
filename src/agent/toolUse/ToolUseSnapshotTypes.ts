// Third-party imports
import { z } from 'zod';

// Local imports - agent
import { type AgentSessionDescriptor } from '@agent/core/AgentDataclass';
import { AgentWorkspaceState } from '@agent/core/AgentWorkspaceState';
import { AgentSessionDescriptorSchema } from '@agent/core/AgentSessionSchema';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

export const TOOL_USE_SNAPSHOT_VERSION = 1;

export const AgentWorkspaceStateSnapshotSchema = z.strictObject({
  assembly: z.strictObject({
    lastResponse: z.string(),
    accumulatedOutput: z.string(),
  }),
  media: z.strictObject({ files: z.array(z.string()) }),
  reasoning: z.strictObject({
    thinkingBlocks: z.array(z.unknown()),
    thinkingAdded: z.boolean(),
  }),
  document: z.strictObject({ texcountStats: z.string().nullable() }),
});

export type AgentWorkspaceStateSnapshot = z.infer<
  typeof AgentWorkspaceStateSnapshotSchema
>;

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
  agentName: z.string(),
  model: z.string(),
  session: AgentSessionDescriptorSchema,
  messages: z.array(ProviderMessageSchema),
  toolState: AgentWorkspaceStateSnapshotSchema,
  lastUpdated: z.number(),
});

export type ToolUseSessionSnapshot = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

export interface SaveToolUseSnapshotPayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  session: AgentSessionDescriptor;
  messages: ProviderMessage[];
  toolState: AgentWorkspaceState;
}

// Legacy normalization removed; snapshots must conform to the strict schema.
