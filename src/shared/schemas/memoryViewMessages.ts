/**
 * Schema definitions for MemoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_MEMORY, UPDATE_MEMORY_ENABLED)
 * Inbound: Frontend → Backend (GET_MEMORY_DATA, OPEN_MEMORY_FILE, etc.)
 */
import { z } from 'zod';

import { MEMORY_VIEW_COMMANDS } from '@shared/ipc';
import { commandOnly } from './messageFactories';

// ============================================================
// Data schemas
// ============================================================

const MemoryViewItemSchema = z.object({
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

const MemoryPreviewSchema = z.object({
  storagePath: z.string(),
  lineCount: z.number().optional(),
  preview: z.string().optional(),
  error: z.boolean().optional(),
});
export type MemoryPreview = z.infer<typeof MemoryPreviewSchema>;

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateMemoryMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UPDATE_MEMORY),
  items: z.array(MemoryViewItemSchema),
});

export const UpdateMemoryPreviewMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW),
  preview: MemoryPreviewSchema,
});

export const UpdateMemoryEnabledMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.UPDATE_MEMORY_ENABLED),
  enabled: z.boolean(),
});

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Memory path message for file operations (reusable field schema) */
const MemoryPathMessageSchema = z.object({
  storagePath: z.string().min(1),
});

// Inbound messages with command literals
export const GetMemoryDataMessageSchema = commandOnly(
  MEMORY_VIEW_COMMANDS.GET_MEMORY_DATA,
);

export const GetMemoryPreviewMessageSchema = MemoryPathMessageSchema.extend({
  command: z.literal(MEMORY_VIEW_COMMANDS.GET_MEMORY_PREVIEW),
});

export const OpenMemoryFileMessageSchema = MemoryPathMessageSchema.extend({
  command: z.literal(MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FILE),
});

export const OpenMemoryFolderMessageSchema = commandOnly(
  MEMORY_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
);

/** Carries the display path so the host can confirm before deleting. */
export const DeleteMemoryMessageSchema = MemoryPathMessageSchema.extend({
  command: z.literal(MEMORY_VIEW_COMMANDS.DELETE_MEMORY),
  displayPath: z.string().min(1),
});

export const SetMemoryEnabledMessageSchema = z.object({
  command: z.literal(MEMORY_VIEW_COMMANDS.SET_MEMORY_ENABLED),
  enabled: z.boolean(),
});

export const PinMemoryMessageSchema = MemoryPathMessageSchema.extend({
  command: z.literal(MEMORY_VIEW_COMMANDS.PIN_MEMORY),
});

export const UnpinMemoryMessageSchema = MemoryPathMessageSchema.extend({
  command: z.literal(MEMORY_VIEW_COMMANDS.UNPIN_MEMORY),
});
