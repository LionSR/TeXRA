import { vscode } from './vscodeApi.js';
import { saveState } from './stateManager.js';
import { MULTIPLE_SELECTIONS } from './constants.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeSetElementValue,
  capitalize,
  uncapitalize,
} from './utils.js';

export function updateFileSelect(id, files) {
  const selectDiv = document.getElementById(id);
  if (!selectDiv) {
    console.error(`[FileHandlers] Element with id '${id}' not found`);
    return;
  }
  selectDiv.innerHTML =
    '<option value="">None</option>' +
    files.map((file) => `<option value="${file}">${file}</option>`).join('');
}

export function updateEditedFileSelect(baseFile) {
  const editedFileDiv = safeGetElementById('editedFile');
  if (!editedFileDiv) return;

  if (baseFile) {
    // Store current edited file selection
    const currentEditedFile = editedFileDiv.value;

    // Request updated list of edited files
    vscode.postMessage({
      command: 'requestEditedFile',
      baseFile: baseFile,
      preserveSelection: currentEditedFile, // Pass current selection to preserve it if still valid
    });
  } else {
    // Only clear if there's no base file
    updateFileSelect('editedFile', []);
  }
}

export function addFileToList(containerId, file) {
  const container = safeGetElementById(containerId);
  const toggleIcon = safeGetElementById(`toggle${capitalize(containerId)}`);
  if (!container || !toggleIcon) return;

  const fileElement = document.createElement('div');
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;

  const removeButton = fileElement.querySelector('.remove-button');
  if (removeButton) {
    addEventListenerSafely(removeButton, 'click', () => {
      container.removeChild(fileElement);
      if (container.children.length === 0) {
        emptyMultipleFiles(containerId, `toggle${capitalize(containerId)}`);
      }
    });
  }
  container.appendChild(fileElement);
}

export function updateMultipleFileSelect(selectId, toggleId, files) {
  const selectDiv = safeGetElementById(selectId);
  const toggleIcon = safeGetElementById(toggleId);
  if (!selectDiv || !toggleIcon) return;

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
    // vscode.postMessage({
    //   command: 'showInformationMessage',
    //   text: `Added ${newFiles.length} file(s) to ${selectId}`,
    // });
  }
  saveState();
}

export function getSelectedFiles(multipleFilesDiv) {
  const fileElements = multipleFilesDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(
    (el) => el.textContent.replace(' -', '') || '',
  );
}

export function hideEmptyMultipleFileSelects() {
  MULTIPLE_SELECTIONS.forEach((id) => {
    const selectDiv = safeGetElementById(id);
    if (!selectDiv) return;
    const toggleId = `toggle${capitalize(id)}`;
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
  const container = safeGetElementById(`${containerId}Container`);
  const toggleIcon = safeGetElementById(toggleId);
  if (!container || !toggleIcon) {
    console.error(`Container or toggle icon not found for ${containerId}`);
    return;
  }

  container.style.display = isVisible ? 'block' : 'none';
  toggleIcon.textContent = isVisible ? '▲' : '▼';
}

export function setElementsDisabled(elements, disabled) {
  elements.forEach((element) => {
    if (typeof element === 'string') {
      const elementDiv = document.getElementById(element);
      if (elementDiv) {
        elementDiv.disabled = disabled;
      }
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
    'packLatexdiffvcButton',
    'cleanLatexdiffvcButton',
    'latexdiffvcButton',
  ];
  const commitDiv = document.getElementById('commit');
  commitDiv.innerHTML = '';

  if (message.isGitRepo === false) {
    addOptionToSelect(commitDiv, '', 'Not a Git repository');
    setElementsDisabled([commitDiv, ...commitButtons], true);
  } else {
    addOptionToSelect(commitDiv, 'HEAD', 'HEAD');
    message.commits.forEach((commit) => {
      const [commitHash, ...commitMessageParts] = commit.split(': ');
      const commitMessage = commitMessageParts.join(': ');
      addOptionToSelect(commitDiv, commitHash, commit);
    });
    setElementsDisabled([commitDiv, ...commitButtons], false);
  }
}

export function handleCheckboxChange(event) {
  const checkbox = event?.target || this;
  const checkboxId = checkbox.id;
  const isChecked = checkbox.checked;

  vscode.postMessage({
    command: `update${capitalize(checkboxId)}`,
    value: isChecked,
  });
}

export function initializeOutputFiles() {
  const outputFilesDiv = safeGetElementById('multipleOutputFiles');
  if (!outputFilesDiv) return;

  // Check if there are saved output files
  const state = vscode.getState();
  if (
    state &&
    state.multipleOutputFiles &&
    state.multipleOutputFiles.length > 0
  ) {
    // Use saved values
    outputFilesDiv.innerHTML = '';
    state.multipleOutputFiles.forEach((file) => {
      addFileToList('multipleOutputFiles', file);
    });
  } else {
    // Initialize from input files
    outputFilesDiv.innerHTML = '';
    const inputFileDiv = safeGetElementById('inputFile');
    const multipleInputFilesDiv = safeGetElementById('multipleInputFiles');

    // Add the main input file
    if (inputFileDiv && inputFileDiv.value) {
      addFileToList('multipleOutputFiles', inputFileDiv.value);
    }

    // Add multiple input files
    if (multipleInputFilesDiv) {
      const additionalFiles = getSelectedFiles(multipleInputFilesDiv);
      additionalFiles.forEach((file) => {
        addFileToList('multipleOutputFiles', file);
      });
    }
  }

  // Show the container if files were added
  const container = safeGetElementById('multipleOutputFilesContainer');
  const toggleIcon = safeGetElementById('toggleMultipleOutputFiles');
  if (container && toggleIcon && outputFilesDiv.children.length > 0) {
    container.style.display = 'block';
    toggleIcon.textContent = '▲';
  }
  saveState();
}

export function toggleMultipleOutputFiles() {
  const isVisible =
    safeGetElementById('multipleOutputFilesContainer').style.display !== 'none';
  if (!isVisible) {
    initializeOutputFiles();

    // Make sure the Output Filename toggle works when Multiple Outputs is enabled
    const outputNameOverrideInput = safeGetElementById('outputNameOverride');
    const outputNameOverrideToggle = safeGetElementById(
      'toggleOutputNameOverride',
    );

    if (outputNameOverrideInput && outputNameOverrideToggle) {
      // Get the current state from the stored state
      const state = vscode.getState();
      const isOutputNameOverrideVisible =
        state && state.outputNameOverrideVisible;

      // Restore the output name override toggle state
      if (isOutputNameOverrideVisible) {
        outputNameOverrideInput.style.display = 'inline-block';
        outputNameOverrideToggle.textContent = '<';
      }
    }
  } else {
    toggleMultipleFiles('multipleOutputFiles', 'toggleMultipleOutputFiles');
  }
  saveState();
}

export function toggleOutputNameOverride() {
  const input = safeGetElementById('outputNameOverride');
  const toggleIcon = safeGetElementById('toggleOutputNameOverride');
  if (!input || !toggleIcon) return;

  const isVisible = input.style.display !== 'none';
  input.style.display = isVisible ? 'none' : 'inline-block';
  toggleIcon.textContent = isVisible ? '>' : '<';

  // Store the visibility state in the vscode state
  const state = vscode.getState() || {};
  state.outputNameOverrideVisible = !isVisible;
  vscode.setState(state);

  saveState();
}

export function toggleMultipleFiles(containerId, toggleId) {
  const container = safeGetElementById(`${containerId}Container`);
  if (!container) return;
  const isVisible = container.style.display !== 'none';
  setMultipleFileSelectVisibility(containerId, toggleId, !isVisible);
  saveState();
}

export function emptyMultipleFiles(containerId, toggleId) {
  const listDiv = safeGetElementById(containerId);
  const container = safeGetElementById(`${containerId}Container`);
  if (!listDiv || !container) return;
  listDiv.innerHTML = '';
  container.style.display = 'none';
  const toggleIconDiv = safeGetElementById(toggleId);
  if (toggleIconDiv) toggleIconDiv.textContent = '▼';

  // Reset Output Filename override if we're emptying multiple output files
  if (containerId === 'multipleOutputFiles') {
    const outputNameOverrideInput = safeGetElementById('outputNameOverride');
    const outputNameOverrideToggle = safeGetElementById(
      'toggleOutputNameOverride',
    );

    if (outputNameOverrideInput && outputNameOverrideToggle) {
      outputNameOverrideInput.style.display = 'none';
      outputNameOverrideToggle.textContent = '>';

      // Update the state
      const state = vscode.getState() || {};
      state.outputNameOverrideVisible = false;
      vscode.setState(state);
    }
  }

  saveState();
}

export function handleSetCurrentFile({ fileType, filePath }) {
  const fileId = `${uncapitalize(fileType)}File`;
  const fileDiv = document.getElementById(fileId);
  if (!fileDiv) {
    console.warn(`Element with id '${fileId}' not found`);
    return;
  }

  const options = Array.from(fileDiv.options);
  if (options.some((option) => option.value === filePath)) {
    safeSetElementValue(fileId, filePath);
    fileDiv.dispatchEvent(new Event('change'));
  } else {
    vscode.postMessage({
      command: 'showInformationMessage',
      text: `The current file is not in the ${fileType} file list: ${filePath}`,
    });
  }
}
