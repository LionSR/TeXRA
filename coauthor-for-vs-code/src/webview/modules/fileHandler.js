import { vscode } from './vscodeApi.js';
import { saveState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './utils.js';

export function addFileToList(containerId, file) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(
    `toggle${containerId.charAt(0).toUpperCase() + containerId.slice(1)}`,
  );
  const fileElement = document.createElement('div');
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;
  fileElement.querySelector('.remove-button').addEventListener('click', () => {
    container.removeChild(fileElement);
    if (container.children.length === 0) {
      containerId === 'multipleOutputFilesSelect'
        ? handleEmptyOutputFiles()
        : ((container.style.display = 'none'),
          (toggleIcon.textContent = '▼'),
          saveState());
    }
  });
  container.appendChild(fileElement);
}

export function getSelectedFiles(multipleFilesSelectDiv) {
  const fileElements = multipleFilesSelectDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(
    (el) => el.textContent.replace(' -', '') || '',
  );
}

export function handleEmptyOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleMultipleOutputFiles');
  outputFilesContainer.style.display = 'none';
  toggleIcon.textContent = '▼';
  saveState();
}

export function hideEmptyMultipleFileSelects() {
  MULTIPLE_SELECTIONS.forEach((id) => {
    const selectDiv = document.getElementById(id);
    const baseId = id.replace('Select', '');
    const toggleId = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
    if (selectDiv.children.length === 0) {
      setMultipleFileSelectVisibility(id, toggleId, false);
    }
  });
}

export function setMultipleFileSelectVisibility(
  containerId,
  toggleId,
  isVisible,
) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(toggleId);
  container.style.display = isVisible ? 'block' : 'none';
  if (toggleIcon === null) {
    console.error('toggleIcon is null');
    console.log('toggleId:', toggleId);
  }
  toggleIcon.textContent = isVisible ? '▲' : '▼';
}
