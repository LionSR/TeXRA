// Common file type constants
export const FILE_TYPES = ['input', 'reference', 'auxiliary', 'figure', 'output'];
export const SINGLE_FILE_FIELDS = FILE_TYPES.map(type => `${type}File`);
export const MULTIPLE_FILE_FIELDS = FILE_TYPES.map(type => `${type}Files`);
export const ACTIVE_FLAGS = FILE_TYPES.map(type => `${type}FilesActive`);

// Checkbox configuration fields
export const AUTO_EXTRACT_FIELDS = ['autoExtractFigure', 'autoExtractTikzFigure'] as const;
export const TOOL_CONFIG_FIELDS = [
  'attachTeXCount', 
  'usePrefillFromInput', 
  'printInputPrompt', 
  'reflect'
] as const;
