import { capitalize, uncapitalize } from './stringUtils.js';

export function getToggleId(type) {
  return `toggle${capitalize(type)}`;
}

export function getSingleFileId(type) {
  return `${uncapitalize(type)}File`;
}

export function getMultipleFilesId(type) {
  return `${uncapitalize(type)}Files`;
}

export function getCapitalizedMultipleFilesId(type) {
  return capitalize(getMultipleFilesId(type));
}

export function getMultipleFilesContainerId(type) {
  return `${getMultipleFilesId(type)}Container`;
}

export function getSelectButtonId(id) {
  return `select${capitalize(id)}Button`;
}

export function getEmptyButtonId(id) {
  return `empty${capitalize(id)}Button`;
}

export function getCurrentFileButtonId(type) {
  return `current${capitalize(type)}FileButton`;
}

export function getAddOpenedFilesButtonId(type) {
  return `addOpened${capitalize(type)}FilesButton`;
}
