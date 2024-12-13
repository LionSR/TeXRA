export const MULTIPLE_SELECTIONS = [
  'multipleInputFilesSelect',
  'multipleReferenceFilesSelect',
  'multipleAuxiliaryFilesSelect',
  'multipleFiguresSelect',
];

export const CHECK_BOXES = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoExtractTikzFigureReflect',
  'includeTexCount',
];

export const VALUE_ELEMENTS = [
  // parameters
  'agentSelect',
  'modelSelect',
  'reflectSelect',
  // files
  'inputFileSelect',
  'auxiliaryFileSelect',
  'figureFileSelect',
  'referenceFileSelect',
  'editedFileSelect',
  'baseFileSelect',
  // instructions
  'instructionInput',
  // output
  'outputNameOverride',
  // git
  'commitSelect',
];

export const ELEMENTS_TO_SAVE = [...VALUE_ELEMENTS, ...CHECK_BOXES];

export function safeGetElementById(id) {
  const element = document.getElementById(id);
  if (!element) {
    console.warn(`Element with id '${id}' not found`);
  }
  return element;
}

export function addEventListenerSafely(elementOrId, event, handler) {
  const element = typeof elementOrId === 'string' 
    ? safeGetElementById(elementOrId) 
    : elementOrId;
    
  if (element) {
    element.addEventListener(event, handler);
  }
}
