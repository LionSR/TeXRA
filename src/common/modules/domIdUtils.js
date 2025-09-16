import { capitalize, uncapitalize } from './stringUtils.js';

function normalizeType(rawType) {
  if (!rawType) {
    return '';
  }

  const value = `${rawType}`.trim();
  if (!value) {
    return '';
  }

  const withoutPrefixes = value.replace(
    /^(toggle|select|empty|addOpened|current)/i,
    '',
  );

  const withoutSuffixes = withoutPrefixes
    .replace(/(Files|File)(Container|Button)?$/i, '')
    .replace(/Files$/i, '')
    .replace(/File$/i, '');

  return uncapitalize(withoutSuffixes);
}

function getTypeParts(type) {
  const normalized = normalizeType(type);
  if (!normalized) {
    throw new Error(`[domIdUtils] Invalid file type: ${type}`);
  }

  return {
    lower: normalized,
    upper: capitalize(normalized),
  };
}

/**
 * Return the DOM id for a single-file select element.
 * Accepts raw types ("input"), capitalized types ("Input"),
 * or existing identifiers such as "InputFiles".
 */
export function getSingleFileId(type) {
  const { lower } = getTypeParts(type);
  return `${lower}File`;
}

/**
 * Return the DOM id for the multi-file list element for a type.
 * Works with values like "input", "Input", or "inputFiles".
 */
export function getMultipleFilesId(type) {
  const { lower } = getTypeParts(type);
  return `${lower}Files`;
}

/**
 * Return the DOM id for the container wrapping a multi-file list.
 */
export function getMultipleFilesContainerId(type) {
  return `${getMultipleFilesId(type)}Container`;
}

/**
 * Return the DOM id for the toggle element tied to a multi-file list.
 */
export function getToggleId(type) {
  const { upper } = getTypeParts(type);
  return `toggle${upper}Files`;
}

/**
 * Return the DOM id for the "Empty" button next to a single-file selector.
 */
export function getEmptySingleButtonId(type) {
  const { upper } = getTypeParts(type);
  return `empty${upper}FileButton`;
}

/**
 * Return the DOM id for the "Empty" button on a multi-file list header.
 */
export function getEmptyMultipleButtonId(type) {
  const { upper } = getTypeParts(type);
  return `empty${upper}FilesButton`;
}

/**
 * Return the DOM id for the "Select" button on a multi-file list header.
 */
export function getSelectMultipleButtonId(type) {
  const { upper } = getTypeParts(type);
  return `select${upper}FilesButton`;
}

/**
 * Return the DOM id for the "Add opened" button for a multi-file list.
 */
export function getAddOpenedButtonId(type) {
  const { upper } = getTypeParts(type);
  return `addOpened${upper}FilesButton`;
}

/**
 * Return the DOM id for the "Current" button for a single-file selector.
 */
export function getCurrentFileButtonId(type) {
  const { upper } = getTypeParts(type);
  return `current${upper}FileButton`;
}
