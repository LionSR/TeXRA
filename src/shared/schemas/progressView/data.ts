/**
 * ProgressView shared field schemas and data payload schemas. These carry no
 * IPC `command` wrapper so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { z } from 'zod';

import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';

import { AgentCategorySchema } from '../agent';
import { StreamTabIdSchema } from '../identifiers';

// ============================================================
// Shared Field Schemas
// ============================================================

export const AgentCategoryFilterSchema = z.union([
  z.literal('all'),
  AgentCategorySchema,
]);
export type AgentCategoryFilter = z.infer<typeof AgentCategoryFilterSchema>;

export const ProgressViewPlacementSchema = z.enum(['sidebar', 'editor']);
export type ProgressViewPlacement = z.infer<typeof ProgressViewPlacementSchema>;

/**
 * Base schema for stream-scoped messages: those carrying a single `stream` tab
 * id. Compose with `.extend(...)` so the `stream` field is declared once and
 * inbound/outbound message schemas stay consistent.
 */
export const StreamScopedBaseSchema = z.object({ stream: StreamTabIdSchema });

/**
 * Tailed stdout/stderr for a background process/execution. Single source of
 * truth for the shape carried over IPC (`UpdateProcessOutputMessageSchema`)
 * and mirrored in frontend state (CLI `ProcessOutputTail`, extension
 * `ProcessOutputMap` entries) so the three no longer drift independently.
 */
export const ProcessOutputTailSchema = z.object({
  stdout: z.string(),
  stderr: z.string(),
});
export type ProcessOutputTail = z.infer<typeof ProcessOutputTailSchema>;

// ============================================================
// Progress View Data Schemas
// ============================================================

export const MissingOutputsPayloadSchema = z.object({
  missing: z.array(z.string()).prefault([]),
  xmlFile: z.string().nullable().prefault(null),
});

/**
 * Coarse media-attachment classification: `image` vs everything else. Matches
 * the split `normalizeConversationForExport` already renders attachment
 * markers for (`[image attachment]` / `[document attachment]`).
 */
const MediaAttachmentKindSchema = z.enum(['image', 'document']);
export type MediaAttachmentKind = z.infer<typeof MediaAttachmentKindSchema>;

/**
 * `userMessage` row payload (#7508): attachment kind + count only — never
 * bytes — so the archived conversation can render `[image attachment]` /
 * `[document attachment]` markers for media that was sent to the model but
 * only ever lived in the provider message, not the transcript row.
 */
export const UserMessagePayloadSchema = z.object({
  attachments: z.array(MediaAttachmentKindSchema).optional(),
});

export const TOOL_USE_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
} as const;

const ToolUseStatusSchema = z.enum(TOOL_USE_STATUS);

export const ToolUseLogSchema = z
  .object({
    toolName: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    summary: z.string().optional(),
    error: z.string().optional(),
    isError: z.boolean().optional(),
    userInstruction: z.string().optional(),
    status: ToolUseStatusSchema.optional(),
    // Legacy persisted payloads stored the tool name under `tool` instead of
    // `toolName`. Accept it on input and fold it into `toolName` here so
    // resumed/replayed streams keep tool-specific headers, icons, and file
    // links; downstream code (both hosts) reads the canonical `toolName` only.
    tool: z.string().optional(),
  })
  .transform(({ tool, ...rest }) => ({
    ...rest,
    toolName: rest.toolName ?? tool,
  }));
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

const NormalizedToolUseSchema = z.object({
  parsed: z.record(z.string(), z.unknown()),
  toolName: z.string(),
  errorText: z.string(),
  outputText: z.string(),
  userInstructionText: z.string(),
  input: z.unknown(),
  isError: z.boolean(),
  isUserFeedback: z.boolean(),
  headerSummary: z.string(),
  status: ToolUseStatusSchema.optional(),
});
export type NormalizedToolUse = z.infer<typeof NormalizedToolUseSchema>;

// ============================================================
// URL Sanitization
// ============================================================

/** URL field for tool payloads that will be rendered as live links. */
const SafeUrlSchema = z.string().transform(sanitizeLiveLinkUrl);

const WebSearchResultItemSchema = z.object({
  url: SafeUrlSchema.optional(),
  title: z.string().optional(),
  domain: z.string().optional(),
});

export const WebSearchPayloadSchema = z.object({
  query: z.string().optional(),
  results: z.array(WebSearchResultItemSchema).optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
});

export const WebFetchPayloadSchema = z.object({
  url: SafeUrlSchema.optional(),
  title: z.string().optional(),
  provider: z.string().optional(),
  status: z.string().optional(),
  errorCode: z.string().optional(),
  /** Fetched document text, size-capped at the source (#7508). */
  content: z.string().optional(),
});
