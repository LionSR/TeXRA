// Common file type constants
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
];
export const SINGLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}File`);
export const MULTIPLE_FILE_FIELDS = FILE_TYPES.map((type) => `${type}Files`);
export const ACTIVE_FLAGS = FILE_TYPES.map((type) => `${type}FilesActive`);

// Checkbox configuration fields
export const AUTO_EXTRACT_FIELDS = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
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

// Time constants
export const SHORT_SLEEP_MS = 50;
