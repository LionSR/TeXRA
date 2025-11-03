// Third-party imports
import { z } from 'zod';

// Local imports - agent
import {
  AgentCategory,
  AgentType,
  resolveAgentSessionDescriptor,
  type AgentSessionDescriptor,
} from '@agent/core/AgentDataclass';
import { ToolRuntimeState } from '@agent/core/ToolRuntimeState';
import { AgentSessionDescriptorSchema } from '@agent/core/AgentSessionSchema';
import type { ProviderMessage } from '@agent/modelHandlers/types/ProviderMessage';
import type { ExecutionId, StreamTabId } from '@agent/types/IdentifierTypes';

export const TOOL_USE_SNAPSHOT_VERSION = 1;

const ToolRuntimeStateSnapshotStrictSchema = z
  .object({
    assembly: z
      .object({
        lastResponse: z.string(),
        accumulatedOutput: z.string(),
      })
      .strict(),
    media: z.object({ files: z.array(z.string()) }).strict(),
    reasoning: z
      .object({
        thinkingBlocks: z.array(z.unknown()),
        thinkingAdded: z.boolean(),
      })
      .strict(),
    document: z.object({ texcountStats: z.string().nullable() }).strict(),
  })
  .strict();

const ToolRuntimeStateSnapshotLegacySchema = z
  .object({
    lastResponse: z.string().optional(),
    accumulatedOutput: z.string().optional(),
    mediaFiles: z.array(z.string()).optional(),
    thinkingBlocks: z.array(z.unknown()).optional(),
    thinkingAdded: z.boolean().optional(),
    texcountStats: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((legacy) => ({
    assembly: {
      lastResponse: legacy.lastResponse ?? '',
      accumulatedOutput: legacy.accumulatedOutput ?? '',
    },
    media: {
      files: legacy.mediaFiles ?? [],
    },
    reasoning: {
      thinkingBlocks: legacy.thinkingBlocks ?? [],
      thinkingAdded: legacy.thinkingAdded ?? false,
    },
    document: {
      texcountStats: legacy.texcountStats ?? null,
    },
  }));

export type ToolRuntimeStateSnapshot = z.infer<
  typeof ToolRuntimeStateSnapshotStrictSchema
>;

export const ToolRuntimeStateSnapshotSchema = z
  .union([
    ToolRuntimeStateSnapshotStrictSchema,
    ToolRuntimeStateSnapshotLegacySchema,
  ])
  .transform((value): ToolRuntimeStateSnapshot => {
    if ('assembly' in value) {
      return value;
    }
    return value as ToolRuntimeStateSnapshot;
  });

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
    toolState: ToolRuntimeStateSnapshotSchema,
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
  toolState: ToolRuntimeState;
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
