/**
 * Format-agnostic intermediate representation for exporting a conversation.
 *
 * `ExportNode` is what `readCompletedRunConversation` projects from
 * transcript rows, for an app's format specs and text views to consume. It
 * is host-neutral and carries no provider-specific types. An app that sends
 * an export across a process edge validates it with `ExportNodeSchema`.
 */

import { z } from 'zod';

import { MediaAttachmentKindSchema } from '@shared/schemas';

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

const UserPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('attachment'),
    attachmentType: MediaAttachmentKindSchema,
  }),
]);

/** One node of a run's conversation as an export reads it. */
export const ExportNodeSchema = z.discriminatedUnion('kind', [
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
