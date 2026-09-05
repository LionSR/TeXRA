import type { MultipleDocumentFileType } from '@shared/schemas';

export const FILE_SELECTION_COMMAND_IDS = {
  selectInputFiles: 'texra.selectInputFiles',
  selectContextFiles: 'texra.selectContextFiles',
  selectMediaFiles: 'texra.selectMediaFiles',
  selectOutputFiles: 'texra.selectOutputFiles',
  getCurrentFile: 'texra.getCurrentFile',
} as const;

/** The native picker command of each multi-file launcher list. */
export const MULTIPLE_FILE_COMMANDS: ReadonlyMap<
  MultipleDocumentFileType,
  { selectCommand: string }
> = new Map([
  ['input', { selectCommand: FILE_SELECTION_COMMAND_IDS.selectInputFiles }],
  ['context', { selectCommand: FILE_SELECTION_COMMAND_IDS.selectContextFiles }],
  ['media', { selectCommand: FILE_SELECTION_COMMAND_IDS.selectMediaFiles }],
  ['output', { selectCommand: FILE_SELECTION_COMMAND_IDS.selectOutputFiles }],
]);
