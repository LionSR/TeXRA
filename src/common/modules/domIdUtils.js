// Local imports - common
import { capitalize } from './stringUtils.js';

const SINGLE_FILE_TYPES = new Set([
  'input',
  'reference',
  'auxiliary',
  'media',
  'base',
  'edited',
]);

const MULTIPLE_FILE_TYPES = new Set([
  'input',
  'reference',
  'auxiliary',
  'media',
  'output',
]);

const ADD_OPENED_TYPES = new Set(['input', 'reference', 'auxiliary']);

/**
 * Normalize file type values to their canonical lower-case form.
 * Accepts plain types ("input"), camel case variants ("InputFiles"),
 * or DOM ids ("inputFiles").
 * @param {string} type
 * @returns {string}
 */
function normalizeFileType(type) {
  if (!type) return '';
  const base = `${type}`.trim().replace(/(Files|File)$/i, '');
  return base.toLowerCase();
}

/**
 * Build the DOM id for a single-file <select> element.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getSingleFileId(type) {
  const normalized = normalizeFileType(type);
  return SINGLE_FILE_TYPES.has(normalized) ? `${normalized}File` : undefined;
}

/**
 * Build the DOM id for a multi-select container.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getMultipleFilesId(type) {
  const normalized = normalizeFileType(type);
  return MULTIPLE_FILE_TYPES.has(normalized) ? `${normalized}Files` : undefined;
}

/**
 * Build the DOM id for the chevron toggle attached to a multi-select list.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getToggleId(type) {
  const listId = getMultipleFilesId(type);
  return listId ? `toggle${capitalize(listId)}` : undefined;
}

/**
 * Build the DOM id for the wrapper element around a multi-select list.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getFilesContainerId(type) {
  const listId = getMultipleFilesId(type);
  return listId ? `${listId}Container` : undefined;
}

/**
 * Build the DOM id for the "Empty" button next to a single-file selector.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getEmptySingleFileButtonId(type) {
  const normalized = normalizeFileType(type);
  return SINGLE_FILE_TYPES.has(normalized)
    ? `empty${capitalize(normalized)}FileButton`
    : undefined;
}

/**
 * Build the DOM id for the "Empty" button next to a multi-select list.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getEmptyMultipleFilesButtonId(type) {
  const listId = getMultipleFilesId(type);
  return listId ? `empty${capitalize(listId)}Button` : undefined;
}

/**
 * Build the DOM id for the "Select" button that opens the multi-file picker.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getSelectMultipleFilesButtonId(type) {
  const listId = getMultipleFilesId(type);
  return listId ? `select${capitalize(listId)}Button` : undefined;
}

/**
 * Build the DOM id for the "Add opened" button for supported file types.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getAddOpenedFilesButtonId(type) {
  const normalized = normalizeFileType(type);
  const listId = getMultipleFilesId(type);
  return listId && ADD_OPENED_TYPES.has(normalized)
    ? `addOpened${capitalize(listId)}Button`
    : undefined;
}

/**
 * Build the DOM id for the "Current" button tied to single-file selectors.
 * @param {string} type
 * @returns {string | undefined}
 */
export function getCurrentFileButtonId(type) {
  const normalized = normalizeFileType(type);
  return SINGLE_FILE_TYPES.has(normalized)
    ? `current${capitalize(normalized)}FileButton`
    : undefined;
}
