/**
 * Schema definitions for MemoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_MEMORY, UPDATE_MEMORY_ENABLED)
 * Inbound: Frontend → Backend (GET_MEMORY_DATA, OPEN_MEMORY_FILE, etc.)
 */
import { z } from 'zod';

import { MEMORY_VIEW_COMMANDS } from '@common/webview/commands';
import {
  createDispatcher,
  type HandlerRegistry,
} from '@shared/utils/dispatcher';
import { commandOnly } from './messageFactories';

// ============================================================
// Data schemas
// ============================================================

export const MemoryViewItemSchema = z.object({
  displayPath: z.string(),
  storagePath: z.string(),
  size: z.number(),
  mtime: z.string(),
  lineCount: z.number(),
  preview: z.string(),
  /** Agent that last modified this file (from frontmatter attribution). */
  modifiedBy: z.string().optional(),
  /** Whether this memory is pinned as a core long-term insight. */
  pinned: z.boolean().optional(),
});
export type MemoryViewItem = z.infer<typeof MemoryViewItemSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

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

/** Memory path message for file operations (reusable field schema) */
export const MemoryPathMessageSchema = z.object({
  storagePath: z.string().min(1),
});
export type MemoryPathMessage = z.infer<typeof MemoryPathMessageSchema>;

/** Memory item action detail for frontend events (open/delete) */
export const MemoryItemActionDetailSchema = z.object({
  storagePath: z.string(),
  displayPath: z.string().optional(),
});
export type MemoryItemActionDetail = z.infer<
  typeof MemoryItemActionDetailSchema
>;

/** Memory delete message with display path for confirmation (reusable field schema) */
export const MemoryDeleteMessageSchema = MemoryPathMessageSchema.extend({
  displayPath: z.string().min(1),
});
export type MemoryDeleteMessage = z.infer<typeof MemoryDeleteMessageSchema>;

/** Memory enabled toggle message (reusable field schema) */
export const MemoryEnabledMessageSchema = z.object({
  enabled: z.boolean(),
});
export type MemoryEnabledMessage = z.infer<typeof MemoryEnabledMessageSchema>;

// Inbound messages with command literals
export const GetMemoryDataMessageSchema = commandOnly(
  MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA,
);

export const OpenMemoryFileMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE),
  storagePath: z.string().min(1),
});

export const OpenMemoryFolderMessageSchema = commandOnly(
  MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
);

export const DeleteMemoryMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.DELETE_MEMORY),
  storagePath: z.string().min(1),
  displayPath: z.string().min(1),
});

export const GetMemoryEnabledMessageSchema = commandOnly(
  MEMORY_VIEW_COMMANDS.GET_MEMORY_ENABLED,
);

export const SetMemoryEnabledMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED),
  enabled: z.boolean(),
});

export const PinMemoryMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.PIN_MEMORY),
  storagePath: z.string().min(1),
});

export const UnpinMemoryMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UNPIN_MEMORY),
  storagePath: z.string().min(1),
});

// ============================================================
// Discriminated union of all inbound messages
// ============================================================

export const MemoryViewInboundMessageSchema = z.discriminatedUnion('command', [
  GetMemoryDataMessageSchema,
  OpenMemoryFileMessageSchema,
  OpenMemoryFolderMessageSchema,
  DeleteMemoryMessageSchema,
  GetMemoryEnabledMessageSchema,
  SetMemoryEnabledMessageSchema,
  PinMemoryMessageSchema,
  UnpinMemoryMessageSchema,
]);

export type MemoryViewInboundMessage = z.infer<
  typeof MemoryViewInboundMessageSchema
>;

// ============================================================
// Type-safe handler registry and dispatcher
// ============================================================

export type MemoryViewInboundHandlerRegistry =
  HandlerRegistry<MemoryViewInboundMessage>;

export const dispatchMemoryViewInbound = createDispatcher(
  MemoryViewInboundMessageSchema,
);
