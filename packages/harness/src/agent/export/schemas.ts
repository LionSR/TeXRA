/**
 * Format-agnostic intermediate representation for exporting a conversation.
 *
 * `ExportNode` is what `readCompletedRunConversation` projects from
 * transcript rows, for an app's format specs and text views to consume. It
 * is host-neutral and carries no provider-specific types. An app that sends
 * an export across a process edge validates it with `ExportNodeSchema`.
 */

import { Schema } from 'effect';

import { MediaAttachmentKindSchema } from '@shared/schemas';

// ============================================================
// Intermediate representation — format-agnostic
// ============================================================

const UserPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('text'), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('attachment'),
    attachmentType: MediaAttachmentKindSchema,
  }),
]);

/** One node of a run's conversation as an export reads it. */
export const ExportNodeSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('user-message'),
    parts: Schema.Array(UserPartSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal('assistant-text'),
    text: Schema.String,
  }),
  /** Provider reasoning; document exports omit it, text views may show it. */
  Schema.Struct({ kind: Schema.Literal('thinking'), text: Schema.String }),
  /** `input` is the call's raw arguments; each renderer serializes them. */
  Schema.Struct({
    kind: Schema.Literal('tool-call'),
    name: Schema.String,
    input: Schema.Unknown,
  }),
  Schema.Struct({ kind: Schema.Literal('tool-result'), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('web-search'), query: Schema.String }),
]);
export type ExportNode = typeof ExportNodeSchema.Type;
