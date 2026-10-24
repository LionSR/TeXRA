/** One memory file, as the memory tool lists it and every host's memory
 *  view shows it. */
import { Schema } from 'effect';

export const MemoryViewItemSchema = Schema.Struct({
  displayPath: Schema.String,
  storagePath: Schema.String,
  size: Schema.Number,
  mtime: Schema.String,
  lineCount: Schema.optional(Schema.Number),
  preview: Schema.optional(Schema.String),
  previewError: Schema.optional(Schema.Boolean),
  /** Agent that last modified this file (from frontmatter attribution). */
  modifiedBy: Schema.optional(Schema.String),
  /** Whether this memory is pinned as a core long-term insight. */
  pinned: Schema.optional(Schema.Boolean),
});
export type MemoryViewItem = typeof MemoryViewItemSchema.Type;
