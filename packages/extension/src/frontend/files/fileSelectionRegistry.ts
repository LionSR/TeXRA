// Local imports - shared webview commands
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  MULTIPLE_DOCUMENT_FILE_TYPES,
  type MultipleDocumentFileType,
} from '@shared/schemas/fileTypes';

export const FILE_SELECTION_COMMAND_IDS = {
  selectInputFiles: 'texra.selectInputFiles',
  selectContextFiles: 'texra.selectContextFiles',
  selectMediaFiles: 'texra.selectMediaFiles',
  selectOutputFiles: 'texra.selectOutputFiles',
  selectEditedFile: 'texra.selectEditedFile',
  selectBaseFile: 'texra.selectBaseFile',
  refreshInputFiles: 'texra.refreshInputFiles',
  refreshBaseFiles: 'texra.refreshBaseFiles',
  getCurrentFile: 'texra.getCurrentFile',
} as const;

/**
 * Commands for multi-file selection operations.
 * Note: 'edited' is in ExtendedDocumentFileType but not here (no multi-select for edited).
 */
export const MULTIPLE_FILE_COMMANDS: ReadonlyMap<
  MultipleDocumentFileType,
  { selectCommand: string; responseCommand: string }
> = new Map([
  [
    'input',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectInputFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
    },
  ],
  [
    'context',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectContextFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES,
    },
  ],
  [
    'media',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectMediaFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_MEDIA_FILES,
    },
  ],
  [
    'output',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectOutputFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_OUTPUT_FILES,
    },
  ],
]);

/** Narrows a broader file-type value to the subset `MULTIPLE_FILE_COMMANDS` supports. */
export function isMultipleFileType(
  value: string,
): value is MultipleDocumentFileType {
  return (MULTIPLE_DOCUMENT_FILE_TYPES as readonly string[]).includes(value);
}
