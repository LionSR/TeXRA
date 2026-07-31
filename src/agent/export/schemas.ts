/**
 * Format-agnostic intermediate representation schemas for chat export.
 *
 * These describe the `ExportNode` produced by normalization and consumed by
 * every renderer (markdown, LaTeX, HTML). They are host-neutral and carry no
 * provider-specific types — the command-layer export package imports these
 * without pulling in `openai/*`, `@agent/modelHandlers/openai/*`, or
 * `@google/genai`.
 *
 * Zod schemas are the single source of truth; types are derived with `z.infer`.
 */

import { z } from 'zod';

import type { MediaAttachmentKind } from '@shared/schemas';

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

const ChatExportInputSchema = z.object({
  timestamp: z.string(),
  description: z.string().optional(),
  config: ExportConfigSchema,
  messages: z.array(z.unknown()),
});
export type ChatExportInput = z.infer<typeof ChatExportInputSchema>;

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

const WebSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
});

/**
 * Attachment kinds a renderer must be able to label. Kept in step with the
 * canonical {@link MediaAttachmentKind} vocabulary: the transcript row and the
 * exported document describe the same attachment, so a kind added there must
 * also gain a label in every format spec.
 */
const EXPORT_ATTACHMENT_TYPES = [
  'image',
  'document',
] as const satisfies readonly MediaAttachmentKind[];

export type ExportAttachmentType = (typeof EXPORT_ATTACHMENT_TYPES)[number];

const UserPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('attachment'),
    attachmentType: z.enum(EXPORT_ATTACHMENT_TYPES),
  }),
]);
export type UserPart = z.infer<typeof UserPartSchema>;

const ExportNodeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user-message'), parts: z.array(UserPartSchema) }),
  z.object({ kind: z.literal('assistant-text'), text: z.string() }),
  z.object({
    kind: z.literal('tool-call'),
    name: z.string(),
    input: z.string(),
  }),
  z.object({ kind: z.literal('tool-result'), text: z.string() }),
  z.object({ kind: z.literal('web-search'), query: z.string() }),
  z.object({
    kind: z.literal('web-search-results'),
    results: z.array(WebSearchResultSchema),
  }),
  z.object({
    kind: z.literal('web-fetch'),
    url: z.string().optional(),
    title: z.string().optional(),
    content: z.string().optional(),
  }),
]);
export type ExportNode = z.infer<typeof ExportNodeSchema>;

// ============================================================
// Document metadata
// ============================================================

const DocumentMetaSchema = z.object({
  date: z.string(),
  agent: z.string().optional(),
  model: z.string().optional(),
  description: z.string().optional(),
  instruction: z.string().optional(),
  files: z.array(z.tuple([z.string(), z.string()])),
});
export type DocumentMeta = z.infer<typeof DocumentMetaSchema>;
