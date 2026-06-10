// Barrel export for common file utilities
export {
  ExtensionCategory,
  EXTENSION_CATEGORIES,
  getFilterExtensions,
  getIncludedExtensions,
  isLatexFile,
  isTexFile,
  LATEX_EXTENSIONS,
} from './fileTypeUtils';
export {
  containsExcludedDirectory,
  containsHiddenSegment,
  getBaseNameWithoutRound,
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  passesFileFilters,
  prepareFileFilters,
  sanitizeDirectories,
  shouldVisitDirectory,
  type FileListConfig,
  type FileListSettings,
  type ListableFileType,
  type PreparedFileFilters,
} from './fileListingRules';
export {
  FILE_SELECTION_COMMAND_IDS,
  MULTIPLE_FILE_COMMANDS,
  type FileSelectionCommandId,
  type FileSelectionResponseCommand,
  type MultiFileCategory,
} from './fileSelectionRegistry';
