import { z } from 'zod';

import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands';

export const MemoryViewItemSchema = z.object({
  displayPath: z.string(),
  storagePath: z.string(),
  size: z.number(),
  mtime: z.string(),
  lineCount: z.number(),
  preview: z.string(),
});
export type MemoryViewItem = z.infer<typeof MemoryViewItemSchema>;

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

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Memory path message for file operations (inbound) */
export const MemoryPathMessageSchema = z.object({
  storagePath: z.string().min(1),
});
export type MemoryPathMessage = z.infer<typeof MemoryPathMessageSchema>;

/** Memory delete message with display path for confirmation (inbound) */
export const MemoryDeleteMessageSchema = MemoryPathMessageSchema.extend({
  displayPath: z.string().min(1),
});
export type MemoryDeleteMessage = z.infer<typeof MemoryDeleteMessageSchema>;

/** Memory enabled toggle message (inbound) */
export const MemoryEnabledMessageSchema = z.object({
  enabled: z.boolean(),
});
export type MemoryEnabledMessage = z.infer<typeof MemoryEnabledMessageSchema>;
