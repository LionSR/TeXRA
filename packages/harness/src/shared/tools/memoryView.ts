/** One memory file, as the memory tool lists it and every host's memory
 *  view shows it. */
import { z } from 'zod';

export const MemoryViewItemSchema = z.object({
  displayPath: z.string(),
  storagePath: z.string(),
  size: z.number(),
  mtime: z.string(),
  lineCount: z.number().optional(),
  preview: z.string().optional(),
  previewError: z.boolean().optional(),
  /** Agent that last modified this file (from frontmatter attribution). */
  modifiedBy: z.string().optional(),
  /** Whether this memory is pinned as a core long-term insight. */
  pinned: z.boolean().optional(),
});
export type MemoryViewItem = z.infer<typeof MemoryViewItemSchema>;
