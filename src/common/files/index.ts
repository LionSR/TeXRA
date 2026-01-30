// Barrel export for common file utilities
export { isFile, isDirectory } from './fsEntryType';
export {
  ExtensionCategory,
  getFilterExtensions,
  getIncludedExtensions,
  isLatexFile,
  isTexFile,
  LATEX_EXTENSIONS,
} from './fileTypeUtils';
export {
  FILE_SELECTION_COMMANDS,
  FILE_SELECTION_COMMAND_IDS,
  FILE_SELECTION_RESPONSES,
  MULTIPLE_FILE_COMMANDS,
  type FileSelectionCommand,
  type FileSelectionCommandId,
  type FileSelectionResponseCommand,
  type MultiFileCategory,
} from './fileSelectionRegistry';
