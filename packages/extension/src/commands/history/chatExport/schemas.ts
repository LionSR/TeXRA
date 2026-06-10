/**
 * Input and intermediate-representation schemas for chat export.
 *
 * Zod schemas are the single source of truth; types are derived with
 * `z.infer`. The input schemas accept Anthropic, OpenAI (Chat Completions
 * and Response API), and Google GenAI message shapes; the IR schemas
 * describe the format-agnostic `ExportNode` produced by normalization.
 */

import { z } from 'zod';

// ============================================================
// Input schemas
// ============================================================

/** Loose schema for API content blocks — accepts many optional fields.
 *  Covers Anthropic, OpenAI Chat Completions, and OpenAI Response API formats. */
export const ContentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  content: z.unknown().optional(),
  source: z
    .looseObject({ type: z.string(), media_type: z.string().optional() })
    .optional(),
  query: z.string().optional(),
  search_results: z
    .array(
      z.looseObject({
        title: z.string().optional(),
        url: z.string().optional(),
      }),
    )
    .optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  page_content: z.string().optional(),
  // OpenAI Response API fields
  arguments: z.string().optional(),
  output: z.string().optional(),
});
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const ConversationMessageSchema = z.looseObject({
  role: z.string().optional(),
  content: z
    .union([z.string(), z.array(ContentBlockSchema), z.unknown()])
    .optional(),
  // Google GenAI uses `parts` instead of `content`
  parts: z.array(z.unknown()).optional(),
  // OpenAI Chat Completions: tool_calls on assistant messages
  tool_calls: z.array(z.unknown()).optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ExportConfigSchema = z.object({
  agent: z.string().optional(),
  model: z.string().optional(),
  instruction: z.string().optional(),
  inputFiles: z.array(z.string()).optional(),
  mediaFiles: z.array(z.string()).optional(),
  contextFiles: z.array(z.string()).optional(),
  outputFiles: z.array(z.string()).optional(),
});
export type ExportConfig = z.infer<typeof ExportConfigSchema>;

export const ChatExportInputSchema = z.object({
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

const UserPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('attachment'),
    attachmentType: z.enum(['image', 'document']),
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
