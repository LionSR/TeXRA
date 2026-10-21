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

import { z } from 'zod';

import { ExportNodeSchema } from '@texra-ai/harness';
import type { MediaAttachmentKind } from '@texra-ai/harness/schemas';

// ============================================================
// Export configuration (caller-supplied)
// ============================================================

const ExportConfigSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
});
export type ExportConfig = z.infer<typeof ExportConfigSchema>;

/**
 * Attachment kinds a renderer must be able to label: the canonical media
 * attachment vocabulary, since the transcript row and the exported document
 * describe the same attachment, so a kind added there must also gain a label
 * in every format spec.
 */
export type ExportAttachmentType = MediaAttachmentKind;

/** A run's export input: its setup and its conversation's nodes. */
export const ChatExportInputSchema = z.object({
  timestamp: z.string(),
  description: z.string().optional(),
  config: ExportConfigSchema,
  nodes: z.array(ExportNodeSchema).readonly(),
});
export type ChatExportInput = z.infer<typeof ChatExportInputSchema>;

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
