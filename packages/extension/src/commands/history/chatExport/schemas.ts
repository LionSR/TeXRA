/**
 * Input and intermediate-representation schemas for chat export.
 *
 * The provider-independent IR schemas (`ExportNode`, `UserPart`,
 * `ExportConfig`, `ChatExportInput`, `DocumentMeta`) are defined in
 * `@agent/export/schemas` and re-exported here so the command-layer
 * renderers don't pull in provider SDK types.
 *
 * Input schemas (`ContentBlock`, `ConversationMessage`) remain here as
 * they describe raw provider message shapes consumed only by the
 * normalization layer — these are kept for backward compatibility.
 */

import { z } from 'zod';

export {
  type ChatExportInput,
  type DocumentMeta,
  type ExportConfig,
  type ExportNode,
  type UserPart,
} from '@agent/export/schemas';

// ============================================================
// Input schemas (legacy — normalization now lives in src/agent/export/)
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
