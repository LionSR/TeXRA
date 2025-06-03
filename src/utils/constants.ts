// Common file type constants
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
] as const;

export type FileType = (typeof FILE_TYPES)[number];
export const SINGLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}File`);
export const MULTIPLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}Files`);
export const ACTIVE_FLAGS = FILE_TYPES.map((type) => `${type}FilesActive`);

// Checkbox configuration fields
export const AUTO_EXTRACT_FIELDS = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoCompileInputPdf',
] as const;
export const TOOL_CONFIG_FIELDS = [
  'attachTeXCount',
  'usePrefillFromInput',
  'printInputPrompt',
  'reflect',
] as const;

// Length for preview slices of tool output and responses
export const K_SLICE = 200;

// Generic preview lengths for logging and repetition checks
export const MESSAGE_PREVIEW_LENGTH = 50;
export const REPETITION_PREVIEW_LENGTH = 400;
export const REPETITION_DETECTION_THRESHOLD = 1000;

// for file preview
export const MAX_PREVIEW_LENGTH = 1000;

// Time constants
export const SHORT_SLEEP_MS = 50;
export const REFRESH_THRESHOLD_MS = 200;
export const DIFF_EDITOR_DELAY_MS = 100;
export const WORD_WRAP_INIT_DELAY_MS = 200;
export const DIFF_REGISTRATION_DELAY_MS = 300;
