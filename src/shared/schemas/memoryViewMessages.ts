/**
 * Memory view message schemas.
 */

// Third-party imports
import { z } from 'zod';

// Local imports - webview commands
import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands';

// =============================================================================
// Data Schemas
// =============================================================================

export const MemoryViewItemSchema = z.object({
  displayPath: z.string(),
  storagePath: z.string(),
  size: z.number(),
  mtime: z.string(),
  lineCount: z.number(),
  preview: z.string(),
});
export type MemoryViewItem = z.infer<typeof MemoryViewItemSchema>;

// =============================================================================
// Backend → Frontend Messages
// =============================================================================

export const UpdateMemoryMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UPDATE_MEMORY),
  items: z.array(MemoryViewItemSchema),
});
export type UpdateMemoryMessage = z.infer<typeof UpdateMemoryMessageSchema>;

export const UpdateMemoryEnabledMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED),
  enabled: z.boolean(),
});
export type UpdateMemoryEnabledMessage = z.infer<
  typeof UpdateMemoryEnabledMessageSchema
>;
