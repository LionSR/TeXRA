import { vscode } from './vscodeApi.js';
import { saveState } from './stateManager.js';
import { MULTIPLE_SELECTIONS, addEventListenerSafely } from './utils.js';

export function updateFileSelect(selectId, files) {
  const select = document.getElementById(selectId);
  if (!select) return console.error(`Element with id '${selectId}' not found`);
  select.innerHTML =
    '<option value="">None</option>' +
    files.map((file) => `<option value="${file}">${file}</option>`).join('');
}

export function updateEditedFileSelect(baseFile) {
  if (baseFile) {
    vscode.postMessage({
      command: 'requestEditedFile',
      baseFile: baseFile,
    });
  } else {
    updateFileSelect('editedFileSelect', []);
  }
}

export function addFileToList(containerId, file) {
  const container = document.getElementById(containerId);
  const toggleIcon = document.getElementById(
    `toggle${containerId.charAt(0).toUpperCase() + containerId.slice(1)}`,
  );
  const fileElement = document.createElement('div');
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;

  const removeButton = fileElement.querySelector('.remove-button');
  if (removeButton) {
    addEventListenerSafely(removeButton, 'click', () => {
      container.removeChild(fileElement);
      if (container.children.length === 0) {
        containerId === 'multipleOutputFilesSelect'
          ? handleEmptyOutputFiles()
          : ((container.style.display = 'none'),
            (toggleIcon.textContent = '▼'),
            saveState());
      }
    });
  }
  container.appendChild(fileElement);
}

export function updateMultipleFileSelect(selectId, toggleId, files) {
  const selectDiv = document.getElementById(selectId);
  const toggleIcon = document.getElementById(toggleId);
  const existingFiles = getSelectedFiles(selectDiv);
  const newFiles = files.filter((file) => !existingFiles.includes(file));
  if (newFiles.length > 0) {
    newFiles.forEach((file) => {
      addFileToList(selectId, file);
    });
    selectDiv.style.display = 'block';
    toggleIcon.textContent = '▲';
    const containerDiv = selectDiv.closest('.file-select');
    if (containerDiv) {
      containerDiv.style.display = 'block';
    }
    vscode.postMessage({
      command: 'showInformationMessage',
      text: `Added ${newFiles.length} file(s) to ${selectId}`,
    });
  }
  saveState();
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

export function setElementsDisabled(elements, disabled) {
  elements.forEach((element) => {
    if (typeof element === 'string') {
      document.getElementById(element).disabled = disabled;
    } else {
      element.disabled = disabled;
    }
  });
}

export function addOptionToSelect(select, value, text) {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = text;
  select.appendChild(option);
}

export function handleRecentCommits(message) {
  const commitButtons = [
    'packLatexDiffVCButton',
    'cleanLatexDiffVCButton',
    'latexDiffVCButton',
  ];
  const commitSelect = document.getElementById('commitSelect');
  commitSelect.innerHTML = '';

  if (message.isGitRepo === false) {
    addOptionToSelect(commitSelect, '', 'Not a Git repository');
    setElementsDisabled([commitSelect, ...commitButtons], true);
  } else {
    addOptionToSelect(commitSelect, 'HEAD', 'HEAD');
    message.commits.forEach((commit) => {
      const [commitHash, ...commitMessageParts] = commit.split(': ');
      const commitMessage = commitMessageParts.join(': ');
      addOptionToSelect(commitSelect, commitHash, commit);
    });
    setElementsDisabled([commitSelect, ...commitButtons], false);
  }
}

export function handleCheckboxChange(event) {
  const checkboxId = event.target.id;
  const isChecked = event.target.checked;
  vscode.postMessage({
    command: `update${checkboxId.charAt(0).toUpperCase() + checkboxId.slice(1)}`,
    value: isChecked,
  });
}

export function initializeOutputFiles() {
  const inputFileSelect = document.getElementById('inputFileSelect');
  const multipleInputFilesSelect = document.getElementById(
    'multipleInputFilesSelect',
  );
  const outputFilesDiv = document.getElementById('multipleOutputFilesSelect');
  outputFilesDiv.innerHTML = '';

  // Add the main input file
  if (inputFileSelect.value) {
    addFileToList('multipleOutputFilesSelect', inputFileSelect.value);
  }

  // Add multiple input files
  const additionalFiles = getSelectedFiles(multipleInputFilesSelect);
  additionalFiles.forEach((file) => {
    addFileToList('multipleOutputFilesSelect', file);
  });
}

export function toggleMultipleOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleMultipleOutputFiles');
  if (outputFilesContainer.style.display === 'none') {
    outputFilesContainer.style.display = 'block';
    toggleIcon.textContent = '▲';
    initializeOutputFiles();
  } else {
    outputFilesContainer.style.display = 'none';
    toggleIcon.textContent = '▼';
  }
  saveState();
}

export function toggleOutputNameOverride() {
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleIcon = document.getElementById('toggleOutputNameOverride');
  if (outputNameOverride.style.display === 'none') {
    outputNameOverride.style.display = 'inline-block';
    toggleIcon.textContent = '▲';
  } else {
    outputNameOverride.style.display = 'none';
    toggleIcon.textContent = '▼';
  }
  saveState();
}

export function toggleMultipleFiles(containerId, toggleId) {
  const container = document.getElementById(containerId);
  const isVisible = container.style.display !== 'none';
  setMultipleFileSelectVisibility(containerId, toggleId, !isVisible);

  saveState();
}

export function emptyMultipleFiles(containerId, toggleId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  container.style.display = 'none';
  document.getElementById(toggleId).textContent = '▼';
  saveState();
}
