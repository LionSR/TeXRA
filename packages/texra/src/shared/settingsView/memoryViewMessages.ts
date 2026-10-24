/**
 * Schema definitions for MemoryView messages.
 *
 * Outbound: Backend → Frontend (UPDATE_MEMORY, UPDATE_MEMORY_PREVIEW)
 * Inbound: Frontend → Backend (GET_MEMORY_DATA, OPEN_MEMORY_FILE, etc.)
 */
import { Schema, Struct } from 'effect';

import { MemoryViewItemSchema } from '@texra-ai/harness/schemas';
import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';
import { commandOnly } from './messageFactories';

// ============================================================
// Data schemas
// ============================================================

const MemoryPreviewSchema = Schema.Struct({
  storagePath: Schema.String,
  lineCount: Schema.optional(Schema.Number),
  preview: Schema.optional(Schema.String),
  error: Schema.optional(Schema.Boolean),
});

// ============================================================
// Outbound message schemas (backend → frontend)
// ============================================================

export const UpdateMemoryMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY),
  items: Schema.Array(MemoryViewItemSchema),
});

export const UpdateMemoryPreviewMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UPDATE_MEMORY_PREVIEW),
  preview: MemoryPreviewSchema,
});

// ============================================================
// Inbound message schemas (frontend → backend)
// ============================================================

/** Memory path message for file operations (reusable field schema) */
const MemoryPathMessageSchema = Schema.Struct({
  storagePath: Schema.String.check(Schema.isMinLength(1)),
});

// Inbound messages with command literals
export const GetMemoryDataMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.GET_MEMORY_DATA,
);

export const GetMemoryPreviewMessageSchema = MemoryPathMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.GET_MEMORY_PREVIEW),
  }),
);

export const OpenMemoryFileMessageSchema = MemoryPathMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FILE),
  }),
);

export const OpenMemoryFolderMessageSchema = commandOnly(
  SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER,
);

/** Carries the display path so the host can confirm before deleting. */
export const DeleteMemoryMessageSchema = MemoryPathMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.DELETE_MEMORY),
    displayPath: Schema.String.check(Schema.isMinLength(1)),
  }),
);

export const PinMemoryMessageSchema = MemoryPathMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.PIN_MEMORY),
  }),
);

export const UnpinMemoryMessageSchema = MemoryPathMessageSchema.mapFields(
  Struct.assign({
    command: Schema.Literal(SETTINGS_VIEW_COMMANDS.UNPIN_MEMORY),
  }),
);
