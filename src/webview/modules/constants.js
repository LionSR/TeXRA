export const MULTIPLE_SELECTIONS = [
  'multipleInputFiles',
  'multipleReferenceFiles',
  'multipleAuxiliaryFiles',
  'multipleFigureFiles',
  'multipleOutputFiles',
];

export const CHECK_BOXES_AUTO_EXTRACT = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
];

export const CHECK_BOXES_TOOL_USE = [
  'attachTeXCount',
  'usePrefillFromInput',
  'printInputPrompt',
  'reflect',
];

export const CHECK_BOXES = [
  ...CHECK_BOXES_AUTO_EXTRACT,
  ...CHECK_BOXES_TOOL_USE,
];

export const VALUE_ELEMENTS = [
  // parameters
  'agent',
  'model',
  // files
  'inputFile',
  'auxiliaryFile',
  'figureFile',
  'referenceFile',
  'editedFile',
  'baseFile',
  // instruction
  'instructionInput',
  // output
  'outputNameOverride',
  // git
  'commit',
];

export const ELEMENTS_TO_SAVE = [...VALUE_ELEMENTS, ...CHECK_BOXES];
