// Local imports - webview commands
import { MAIN_VIEW_COMMANDS } from '@common/webview';

// Local imports - shared schemas
import type { MultipleFileType } from '@shared/schemas';

export const FILE_SELECTION_COMMAND_IDS = {
  selectInputFile: 'texra.selectInputFile',
  selectInputFiles: 'texra.selectInputFiles',
  selectReferenceFile: 'texra.selectReferenceFile',
  selectReferenceFiles: 'texra.selectReferenceFiles',
  selectAuxiliaryFile: 'texra.selectAuxiliaryFile',
  selectAuxiliaryFiles: 'texra.selectAuxiliaryFiles',
  selectMediaFiles: 'texra.selectMediaFiles',
  selectMediaFile: 'texra.selectMediaFile',
  selectOutputFiles: 'texra.selectOutputFiles',
  selectEditedFile: 'texra.selectEditedFile',
  getCurrentFile: 'texra.getCurrentFile',
  selectBaseFile: 'texra.selectBaseFile',
  refreshInputFiles: 'texra.refreshInputFiles',
  refreshBaseFiles: 'texra.refreshBaseFiles',
} as const;

export const FILE_SELECTION_COMMANDS = new Map<string, string>([
  [
    MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE,
    FILE_SELECTION_COMMAND_IDS.selectInputFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE,
    FILE_SELECTION_COMMAND_IDS.selectReferenceFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE,
    FILE_SELECTION_COMMAND_IDS.selectAuxiliaryFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE,
    FILE_SELECTION_COMMAND_IDS.selectMediaFile,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE,
    FILE_SELECTION_COMMAND_IDS.selectEditedFile,
  ],
]);

export const FILE_SELECTION_RESPONSES = new Map<string, string>([
  [
    MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE,
    MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE,
    MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE,
    MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE,
    MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
  ],
  [
    MAIN_VIEW_COMMANDS.SELECT_EDITED_FILE,
    MAIN_VIEW_COMMANDS.EDITED_FILE_SELECTED,
  ],
]);

export const MULTIPLE_FILE_COMMANDS = new Map<
  MultipleFileType,
  { selectCommand: string; responseCommand: string }
>([
  [
    'input',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectInputFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
    },
  ],
  [
    'reference',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectReferenceFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_REFERENCE_FILES,
    },
  ],
  [
    'auxiliary',
    {
      selectCommand: FILE_SELECTION_COMMAND_IDS.selectAuxiliaryFiles,
      responseCommand: MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILES,
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
