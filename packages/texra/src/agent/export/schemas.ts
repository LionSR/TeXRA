/**
 * Chat export's input: a run's setup and its conversation's nodes, which
 * every format spec (markdown and the others) and text view consumes. The
 * nodes are the harness's format-agnostic `ExportNode`, projected from
 * transcript rows by `readCompletedRunConversation`; the HTML export path
 * uses `assembleTrace` instead.
 *
 * The export input also crosses the service's RPC edge (`task.exportInput`),
 * so its shapes are Zod schemas and the types derive from them.
 */

import { Schema } from 'effect';

import { ExportNodeSchema } from '@texra-ai/harness';
import type { MediaAttachmentKind } from '@texra-ai/harness/schemas';

// ============================================================
// Export configuration (caller-supplied)
// ============================================================

const ExportConfigSchema = Schema.Struct({
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  instruction: Schema.optional(Schema.String),
  inputFiles: Schema.optional(Schema.Array(Schema.String)),
  mediaFiles: Schema.optional(Schema.Array(Schema.String)),
  contextFiles: Schema.optional(Schema.Array(Schema.String)),
  outputFiles: Schema.optional(Schema.Array(Schema.String)),
});
export type ExportConfig = typeof ExportConfigSchema.Type;

/**
 * Attachment kinds a renderer must be able to label: the canonical media
 * attachment vocabulary, since the transcript row and the exported document
 * describe the same attachment, so a kind added there must also gain a label
 * in every format spec.
 */
export type ExportAttachmentType = MediaAttachmentKind;

/** A run's export input: its setup and its conversation's nodes. */
export const ChatExportInputSchema = Schema.Struct({
  timestamp: Schema.String,
  description: Schema.optional(Schema.String),
  config: ExportConfigSchema,
  nodes: Schema.Array(ExportNodeSchema),
});
export type ChatExportInput = typeof ChatExportInputSchema.Type;

// ============================================================
// Document metadata
// ============================================================

export interface DocumentMeta {
  date: string;
  agent?: string;
  model?: string;
  description?: string;
  instruction?: string;
  files: Array<{ label: string; value: string }>;
}
