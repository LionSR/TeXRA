/**
 * Format-agnostic intermediate representation for chat export.
 *
 * These describe the `ExportNode` that `readCompletedRunConversation`
 * (`@transcript/completedRunArchive`) projects from transcript rows and every
 * format spec (markdown, LaTeX) and text view consumes. The HTML export path uses
 * `assembleTrace` instead. They are host-neutral and carry no
 * provider-specific types — the command-layer export package imports these
 * without pulling in `openai/*` or `@google/genai`.
 *
 * The export input also crosses the service's RPC edge (`task.exportInput`),
 * so its shapes are Zod schemas and the types derive from them.
 */

import { z } from 'zod';

import { MediaAttachmentKindSchema } from '@shared/schemas';

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

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

/**
 * Attachment kinds a renderer must be able to label: the canonical
 * {@link MediaAttachmentKindSchema} vocabulary, since the transcript row and
 * the exported document describe the same attachment, so a kind added there
 * must also gain a label in every format spec.
 */
export type ExportAttachmentType = z.infer<typeof MediaAttachmentKindSchema>;

const UserPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('attachment'),
    attachmentType: MediaAttachmentKindSchema,
  }),
]);

const ExportNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), parts: z.array(UserPartSchema) }),
  z.object({ kind: z.literal('assistant-text'), text: z.string() }),
  /** Provider reasoning; document exports omit it, text views may show it. */
  z.object({ kind: z.literal('thinking'), text: z.string() }),
  /** `input` is the call's raw arguments; each renderer serializes them. */
  z.object({
    kind: z.literal('tool-call'),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({ kind: z.literal('tool-result'), text: z.string() }),
  z.object({ kind: z.literal('web-search'), query: z.string() }),
]);
export type ExportNode = z.infer<typeof ExportNodeSchema>;

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
