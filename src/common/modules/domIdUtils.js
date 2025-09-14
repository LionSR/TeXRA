import { capitalize, uncapitalize } from './stringUtils.js';

/**
 * Get the DOM id for a single-file select element.
 * @param {string} type - File type (e.g., 'input')
 * @returns {string} DOM id like 'inputFile'
 */
export function getSingleFileId(type) {
  return `${uncapitalize(type)}File`;
}

/**
 * Get the DOM id for a multi-file list element.
 * @param {string} type - File type (e.g., 'input')
 * @returns {string} DOM id like 'inputFiles'
 */
export function getMultipleFilesId(type) {
  return `${uncapitalize(type)}Files`;
}

/**
 * Get the DOM id for a multi-file container element.
 * @param {string} type - File type (e.g., 'input')
 * @returns {string} DOM id like 'inputFilesContainer'
 */
export function getMultipleFilesContainerId(type) {
  return `${getMultipleFilesId(type)}Container`;
}

/**
 * Get the DOM id for a toggle element controlling a list or container.
 * @param {string} id - Base element id (e.g., 'outputFiles')
 * @returns {string} DOM id like 'toggleOutputFiles'
 */
export function getToggleId(id) {
  return `toggle${capitalize(id)}`;
}
