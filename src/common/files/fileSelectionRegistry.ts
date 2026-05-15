// Local imports - shared webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';

export const FILE_SELECTION_COMMAND_IDS = {
  selectInputFile: 'texra.selectInputFile',
  selectContextFile: 'texra.selectContextFile',
  selectInputFiles: 'texra.selectInputFiles',
  selectContextFiles: 'texra.selectContextFiles',
  selectMediaFiles: 'texra.selectMediaFiles',
  selectMediaFile: 'texra.selectMediaFile',
  selectOutputFiles: 'texra.selectOutputFiles',
  selectEditedFile: 'texra.selectEditedFile',
  selectBaseFile: 'texra.selectBaseFile',
  refreshInputFiles: 'texra.refreshInputFiles',
  refreshBaseFiles: 'texra.refreshBaseFiles',
  getCurrentFile: 'texra.getCurrentFile',
} as const;

export type FileSelectionCommandId =
  (typeof FILE_SELECTION_COMMAND_IDS)[keyof typeof FILE_SELECTION_COMMAND_IDS];

export type FileSelectionCommand =
  | typeof MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE
  | typeof MAIN_VIEW_COMMANDS.SELECT_CONTEXT_FILE
  | typeof MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE;

export type FileSelectionResponseCommand =
  | typeof MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED
  | typeof MAIN_VIEW_COMMANDS.CONTEXT_FILE_SELECTED
  | typeof MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED
  | typeof MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED;

/**
 * Maps webview message commands (e.g., 'selectInputFile') to VS Code command IDs
 * (e.g., 'texra.selectInputFile'). These are different namespaces:
 * - MAIN_VIEW_COMMANDS: Internal webview message names
 * - FILE_SELECTION_COMMAND_IDS: VS Code registered command IDs
 */
export const FILE_SELECTION_COMMANDS = new Map<FileSelectionCommand, string>([
  [
    MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE,
    FILE_SELECTION_COMMAND_IDS.selectInputFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_CONTEXT_FILE,
    FILE_SELECTION_COMMAND_IDS.selectContextFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE,
    FILE_SELECTION_COMMAND_IDS.selectMediaFile,
  ],
]);

export const FILE_SELECTION_RESPONSES = new Map<
  FileSelectionCommand,
  FileSelectionResponseCommand
>([
  [
    MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE,
    MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_CONTEXT_FILE,
    MAIN_VIEW_COMMANDS.CONTEXT_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE,
    MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
  ],
]);

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
