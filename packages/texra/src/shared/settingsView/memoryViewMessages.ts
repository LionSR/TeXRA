/**
 * The Memory page's one message: open a memory folder. The notes in it are
 * ordinary files a person reads and edits in their own editor.
 */
import { Schema } from 'effect';

import { SETTINGS_VIEW_COMMANDS } from '@texra/shared/ipc';

/** Which folder: the person's own, or this project's. */
export const MEMORY_FOLDER_SCOPES = Object.freeze(['user', 'project'] as const);
export type MemoryFolderScope = (typeof MEMORY_FOLDER_SCOPES)[number];

export const OpenMemoryFolderMessageSchema = Schema.Struct({
  command: Schema.Literal(SETTINGS_VIEW_COMMANDS.OPEN_MEMORY_FOLDER),
  folder: Schema.Literals(MEMORY_FOLDER_SCOPES),
});
