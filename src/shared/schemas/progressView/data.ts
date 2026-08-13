/**
 * ProgressView shared field schemas and data payload schemas. These carry no
 * IPC `command` wrapper so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { z } from 'zod';

import { sanitizeLiveLinkUrl } from '@shared/utils/liveLinkUrl';

import { StreamTabIdSchema } from '../identifiers';
import { WorkflowScriptDeliverySummarySchema } from '../workflowScriptDelivery';

// ============================================================
// Shared Field Schemas
// ============================================================

export const ProgressViewPlacementSchema = z.enum(['sidebar', 'editor']);
export type ProgressViewPlacement = z.infer<typeof ProgressViewPlacementSchema>;

/**
 * Base schema for stream-scoped messages: those carrying a single `stream` tab
 * id. Compose with `.extend(...)` so the `stream` field is declared once and
 * inbound/outbound message schemas stay consistent.
 */
export const StreamScopedBaseSchema = z.object({ stream: StreamTabIdSchema });

/**
 * StreamScopedBaseSchema plus a `command` literal, with no extra fields.
 * Lives here (not in a per-view message module) so inbound and outbound
 * message schemas that echo the same command — e.g. DELETE_STREAM — compose
 * the identical shape instead of hand-declaring it in each direction.
 */
export function streamScopedCommand<T extends string>(command: T) {
  return StreamScopedBaseSchema.extend({ command: z.literal(command) });
}

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
 * `workflowSummary` carries a workflow delivery's typed presentation facts
 * beside the rendered text, so the progress view renders structured data
 * instead of re-parsing it out of the row text.
 */
export const UserMessagePayloadSchema = z.object({
  attachments: z.array(MediaAttachmentKindSchema).optional(),
  workflowSummary: WorkflowScriptDeliverySummarySchema.optional(),
});

export const TOOL_USE_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;

export type ToolUseStatus =
  (typeof TOOL_USE_STATUS)[keyof typeof TOOL_USE_STATUS];

const ToolUseStatusSchema = z.enum(TOOL_USE_STATUS);

export const ToolUseLogSchema = z.object({
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  summary: z.string().optional(),
  error: z.string().optional(),
  isError: z.boolean().optional(),
  userInstruction: z.string().optional(),
  status: ToolUseStatusSchema.optional(),
});
export type ToolUseLog = z.infer<typeof ToolUseLogSchema>;

/**
 * The flat, renderer-friendly tool-use view `normalizeToolUseData`
 * (`@shared/toolUse`) derives from a parsed {@link ToolUseLog}. Declared as a
 * plain type, not a schema: the producer builds this shape field-by-field and
 * nothing ever parses it, so a Zod schema would own no boundary.
 */
export type NormalizedToolUse = {
  toolName: string;
  errorText: string;
  outputText: string;
  exitCode?: number;
  userInstructionText: string;
  input: unknown;
  isError: boolean;
  isUserFeedback: boolean;
  headerSummary: string;
  status?: ToolUseStatus;
};

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
