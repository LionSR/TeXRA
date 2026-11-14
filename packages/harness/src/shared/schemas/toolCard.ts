/**
 * The tool card and tool-use log schemas every host reads. They carry no IPC
 * `command` wrapper, so both the outbound and inbound message modules can
 * compose them without a circular import.
 */
import { Schema } from 'effect';

import { ScriptDeliverySummarySchema } from './scriptDelivery';
import { StoredMediaSchema } from './storedTurn';

// ============================================================
// Shared Field Schemas
// ============================================================

/** Coarse media-attachment classification: `image` vs everything else. */
export const MediaAttachmentKindSchema = Schema.Literals(['image', 'document']);
export type MediaAttachmentKind = typeof MediaAttachmentKindSchema.Type;

/**
 * `userMessage` row payload: attachment kind + count only — never
 * bytes — so the archived conversation can render `[image attachment]` /
 * `[document attachment]` markers for media that was sent to the model but
 * only ever lived in the provider message, not the transcript row.
 * `media` is what a follow-up attached, by address (the follow-up's row
 * links the blobs), so "Fork from here" puts it back in the fork's composer
 * beside the text without a file to re-read.
 * `scriptSummary` carries a script delivery's typed presentation facts
 * beside the rendered text, so the progress view renders structured data
 * instead of re-parsing it out of the row text.
 */
export const UserMessagePayloadSchema = Schema.Struct({
  attachments: Schema.optional(Schema.Array(MediaAttachmentKindSchema)),
  media: Schema.optional(Schema.Array(StoredMediaSchema)),
  scriptSummary: Schema.optional(ScriptDeliverySummarySchema),
});

/**
 * The one status of a tool call: carried by `tool.end`, folded onto the
 * card, and read by every renderer. A failed call is `failed`; there is no
 * side-channel error flag beside it.
 */
export const TOOL_CALL_STATUS = {
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
} as const;
export const ToolCallStatusSchema = Schema.Enum(TOOL_CALL_STATUS);
export type ToolCallStatus = typeof ToolCallStatusSchema.Type;

/**
 * A card a tool states itself instead of one the fold derives from its tool
 * name: what a plugin reporting an external agent's work (a patch, a thread,
 * a turn) shows. Plain data in the generic section kinds every renderer
 * already paints, so the fold stays plugin-agnostic.
 */
export const ToolCardSchema = Schema.Struct({
  /** The row header, in place of the tool's display name. */
  title: Schema.String,
  sections: Schema.Array(
    Schema.Union([
      Schema.Struct({
        kind: Schema.Literal('text'),
        label: Schema.String,
        text: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal('status'),
        label: Schema.String,
        status: ToolCallStatusSchema,
      }),
      Schema.Struct({
        kind: Schema.Literal('identifier'),
        label: Schema.String,
        value: Schema.String,
      }),
      Schema.Struct({
        kind: Schema.Literal('badges'),
        label: Schema.String,
        badges: Schema.Array(Schema.String),
      }),
      Schema.Struct({
        kind: Schema.Literal('fileList'),
        label: Schema.String,
        files: Schema.Array(
          Schema.Struct({
            path: Schema.String,
            note: Schema.optional(Schema.String),
          }),
        ),
      }),
    ]),
  ),
});
/** A card a tool states itself (`ToolCardSchema`). */
export type ToolCard = typeof ToolCardSchema.Type;

/**
 * An MCP tool call's output: its status, its structured content, and its
 * content blocks. A server need not emit this shape; the tool row shows
 * output that does not parse as it came.
 */
export const McpToolOutputSchema = Schema.Struct({
  status: Schema.optional(Schema.NullOr(ToolCallStatusSchema)),
  structuredContent: Schema.optional(Schema.NullOr(Schema.Unknown)),
  contentBlocks: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))),
  ),
});
/** The output an MCP tool call reports (`McpToolOutputSchema`). */
export type McpToolOutput = typeof McpToolOutputSchema.Type;

export const ToolUseLogSchema = Schema.Struct({
  toolName: Schema.String,
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  summary: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  userInstruction: Schema.optional(Schema.String),
  /** The one spelling of a command row's exit code: the builder that owns the
   *  code states it here, and renderers read it instead of scraping prose. */
  exitCode: Schema.optional(Schema.Int),
  status: Schema.optional(ToolCallStatusSchema),
  card: Schema.optional(ToolCardSchema),
});
export type ToolUseLog = typeof ToolUseLogSchema.Type;

/**
 * The flat, renderer-friendly tool-use view `normalizeToolUse`
 * derives from a parsed {@link ToolUseLog}. Declared as a
 * plain type, not a schema: the producer builds this shape field-by-field and
 * nothing ever parses it, so a schema would own no boundary.
 */
export type NormalizedToolUse = {
  toolName: string;
  errorText: string;
  outputText: string;
  exitCode?: number;
  userInstructionText: string;
  input: unknown;
  isUserFeedback: boolean;
  headerSummary: string;
  status?: ToolCallStatus;
  card?: ToolCard;
};

export const WebSearchPayloadSchema = Schema.Struct({
  query: Schema.optional(Schema.String),
});
