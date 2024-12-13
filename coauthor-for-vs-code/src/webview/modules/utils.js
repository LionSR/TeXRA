export const multipleSelections = [
  'multipleInputFilesSelect',
  'multipleReferenceFilesSelect',
  'multipleAuxiliaryFilesSelect',
  'multipleFiguresSelect',
];

export const checkBoxes = [
  'autoExtractFigure',
  'autoExtractTikzFigure',
  'autoExtractTikzFigureReflect',
  'includeTexCount',
];

export const valueElements = [
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

export const elementsToSave = [...valueElements, ...checkBoxes];


export function safeGetElementById(id) {
	const element = document.getElementById(id);
	if (!element) {
		console.warn(`Element with id '${id}' not found`);
	}
	return element;
}

export function addEventListenerSafely(elementId, event, handler) {
	const element = safeGetElementById(elementId);
	if (element) {
		element.addEventListener(event, handler);
	}
}