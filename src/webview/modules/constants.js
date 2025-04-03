// Basic file types
export const FILE_TYPES = [
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
];

// Single file element IDs
export const SINGLE_FILE_ELEMENTS = [
  'inputFile',
  'referenceFile',
  'auxiliaryFile',
  'mediaFile',
  'editedFile',
  'baseFile',
];

// Multiple file selection element IDs (derived from FILE_TYPES)
export const MULTIPLE_SELECTIONS = FILE_TYPES.map((type) => `${type}Files`);

// Auto extract checkboxes
export const CHECK_BOXES_AUTO_EXTRACT = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
];

// Tool configuration checkboxes
export const CHECK_BOXES_TOOL_USE = [
  'attachTeXCount',
  'usePrefillFromInput',
  'printInputPrompt',
  'reflect',
];

// All checkboxes (combined)
export const CHECK_BOXES = [
  ...CHECK_BOXES_AUTO_EXTRACT,
  ...CHECK_BOXES_TOOL_USE,
];

// Form elements with values to save
export const VALUE_ELEMENTS = [
  // parameters
  'agent',
  'model',
  // files (single)
  ...SINGLE_FILE_ELEMENTS,
  // instruction
  'instruction',
  // output
  'outputNameOverride',
  // git
  'commit',
];

// All elements that need to be saved
export const ELEMENTS_TO_SAVE = [...VALUE_ELEMENTS, ...CHECK_BOXES];
