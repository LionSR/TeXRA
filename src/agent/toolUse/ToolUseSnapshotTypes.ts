// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  AgentCategory,
  AgentType,
  resolveAgentSessionDescriptor,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import {
  ToolResponseState,
  toolResponseStateToSnapshot,
} from '@agent/core/ToolState';
import { AgentSessionDescriptorSchema } from '@agent/core/AgentSessionSchema';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

export const TOOL_USE_SNAPSHOT_VERSION = 1;

const DocumentAssetSnapshotSchema = z
  .object({
    texcountStats: z.string().nullable(),
    mediaFiles: z.array(z.string()),
  })
  .strict();

const ResponseDraftSnapshotSchema = z
  .object({
    lastResponse: z.string(),
    accumulatedOutput: z.string(),
  })
  .strict();

const ReasoningTraceSnapshotSchema = z
  .object({
    thinkingBlocks: z.array(z.unknown()),
    thinkingAdded: z.boolean(),
  })
  .strict();

export const ToolStateSnapshotSchema = z
  .object({
    document: DocumentAssetSnapshotSchema,
    draft: ResponseDraftSnapshotSchema,
    reasoning: ReasoningTraceSnapshotSchema,
  })
  .strict();

const ProviderMessageSchema = z.custom<ProviderMessage>(
  (value): value is ProviderMessage =>
    typeof value === 'object' && value !== null,
  {
    message: 'messages must contain provider message objects',
  },
);

export const ToolUseSessionSnapshotSchema = z
  .object({
    version: z.literal(TOOL_USE_SNAPSHOT_VERSION),
    executionId: z.string(),
    streamId: z.string(),
    agentName: z.string(),
    model: z.string(),
    agentSessionKind: z.enum(AgentCategory).optional(),
    session: AgentSessionDescriptorSchema.optional(),
    messages: z.array(ProviderMessageSchema),
    toolState: ToolStateSnapshotSchema,
    lastUpdated: z.number(),
  })
  .strict();

export type ToolUseSessionSnapshotParsed = z.infer<
  typeof ToolUseSessionSnapshotSchema
>;

export type ToolUseSessionSnapshot = Omit<
  ToolUseSessionSnapshotParsed,
  'agentSessionKind' | 'session'
> & {
  session: Required<AgentSessionDescriptor>;
};

export interface SaveToolUseSnapshotPayload {
  executionId: ExecutionId;
  streamId: StreamTabId;
  agentName: string;
  model: string;
  session: AgentSessionDescriptor;
  messages: ProviderMessage[];
  toolState: ToolResponseState;
}

export function normalizeSnapshot(
  snapshot: ToolUseSessionSnapshotParsed,
): ToolUseSessionSnapshot {
  if (snapshot.session && !snapshot.agentSessionKind) {
    return snapshot as ToolUseSessionSnapshot;
  }

  const descriptor =
    snapshot.session ??
    resolveAgentSessionDescriptor(AgentType.ToolUse, snapshot.agentSessionKind);

  const {
    agentSessionKind: _legacyKind,
    session: _legacySession,
    ...rest
  } = snapshot;

  return {
    ...rest,
    session: {
      agentType: descriptor.agentType ?? AgentType.ToolUse,
      agentCategory: descriptor.agentCategory,
    },
  };
}
