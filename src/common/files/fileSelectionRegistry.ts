// Local imports - shared webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';

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

export type FileSelectionCommandId =
  (typeof FILE_SELECTION_COMMAND_IDS)[keyof typeof FILE_SELECTION_COMMAND_IDS];

// Only `editedFile` still uses single-file selection; input/context/media
// route through SET_*_FILES.
export type FileSelectionResponseCommand =
  typeof MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED;

/** File categories that support multiple file selection */
export type MultiFileCategory = 'input' | 'context' | 'media' | 'output';

/**
 * Commands for multi-file selection operations.
 * Note: 'edited' is in ExtendedDocumentFileType but not here (no multi-select for edited).
 */
export const MULTIPLE_FILE_COMMANDS: ReadonlyMap<
  MultiFileCategory,
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
