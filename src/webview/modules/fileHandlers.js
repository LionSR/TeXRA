import { vscode } from '@common/vscodeApi.js';
import { saveState } from './stateManager.js';
import { getWebviewState, updateWebviewState } from '@common/webviewState.js';
import { MULTIPLE_SELECTIONS } from './constants.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeSetElementValue,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';

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
  fileElement.className = 'file-item';
  fileElement.dataset.path = file;
  fileElement.innerHTML = `${file} <span class="remove-button">-</span>`;

  const removeButton = fileElement.querySelector('.remove-button');
  if (removeButton) {
    addEventListenerSafely(removeButton, 'click', () => {
      container.removeChild(fileElement);
      if (container.children.length === 0) {
        emptyMultipleFiles(containerId, `toggle${capitalize(containerId)}`);
      }
      // Save state after removing the file to persist changes
      saveState();
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
    toggleIcon.innerHTML = '<i class="codicon codicon-chevron-up"></i>';
    const containerDiv = selectDiv.closest('.file-select');
    if (containerDiv) {
      containerDiv.style.display = 'block';
    }
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
  toggleIcon.innerHTML = isVisible
    ? '<i class="codicon codicon-chevron-up"></i>'
    : '<i class="codicon codicon-chevron-down"></i>';
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
      // const commitMessage = commitMessageParts.join(': ');
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

/**
 * Initialize the output files list with the input file
 */
export function initializeOutputFiles() {
  // Get the current state
  const state = getWebviewState();

  // Get references to the DOM elements
  const inputFileDiv = safeGetElementById('inputFile');
  const outputFilesDiv = safeGetElementById('outputFiles');

  // Get the current input file value
  const inputFile = inputFileDiv?.value;

  // Check if we have an input file and output files div
  if (inputFile && outputFilesDiv) {
    // If the state has output files, populate the list
    if (state.outputFiles && state.outputFiles.length > 0) {
      // Clear the list first
      outputFilesDiv.innerHTML = '';

      // Then add each file
      state.outputFiles.forEach((file) => {
        addFileToList('outputFiles', file);
      });
    } else {
      // Clear the list
      outputFilesDiv.innerHTML = '';

      // Add the current input file as output
      addFileToList('outputFiles', inputFileDiv.value);

      // Also add any input files from the multiple input files list
      if (state.inputFiles && state.inputFiles.length > 0) {
        state.inputFiles.forEach((file) => {
          if (file !== inputFile) {
            // Avoid duplicates
            addFileToList('outputFiles', file);
          }
        });
      }
    }
  } else if (outputFilesDiv) {
    // If we don't have an input file, just clear the output files list
    outputFilesDiv.innerHTML = '';
  }

  // Add opened files to the output files list
  const openedFiles = getWebviewState()?.openedFiles ?? [];
  openedFiles.forEach((file) => {
    addFileToList('outputFiles', file);
  });

  // Make sure the Output Filename toggle works when Multiple Outputs is enabled
  const outputNameOverrideInput = safeGetElementById('outputNameOverride');
  const outputNameOverrideToggle = safeGetElementById(
    'toggleOutputNameOverride',
  );

  if (outputNameOverrideInput && outputNameOverrideToggle) {
    // Get the current state from the stored state
    const state = getWebviewState();
    const isOutputNameOverrideVisible =
      state && state.outputNameOverrideVisible;

    // Restore the output name override toggle state
    if (isOutputNameOverrideVisible) {
      outputNameOverrideInput.style.display = 'inline-block';
      outputNameOverrideToggle.innerHTML =
        '<i class="codicon codicon-chevron-left"></i>';
    }
  }

  saveState();
}

export function toggleOutputFiles() {
  const containerVisible =
    safeGetElementById('outputFilesContainer').style.display !== 'none';

  if (containerVisible) {
    toggleMultipleFiles('outputFiles', 'toggleOutputFiles');
  } else {
    initializeOutputFiles();
    toggleMultipleFiles('outputFiles', 'toggleOutputFiles');
  }
}

export function toggleOutputNameOverride() {
  const input = safeGetElementById('outputNameOverride');
  const toggleIcon = safeGetElementById('toggleOutputNameOverride');
  if (!input || !toggleIcon) return;

  const isVisible = input.style.display !== 'none';
  input.style.display = isVisible ? 'none' : 'inline-block';
  toggleIcon.innerHTML = isVisible
    ? '<i class="codicon codicon-chevron-left"></i>'
    : '<i class="codicon codicon-chevron-right"></i>';

  // Store the visibility state in the vscode state
  updateWebviewState({ outputNameOverrideVisible: !isVisible });

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

  // Reset Output Filename override if we're emptying output files
  if (containerId === 'outputFiles') {
    const outputNameOverrideInput = safeGetElementById('outputNameOverride');
    const outputNameOverrideToggle = safeGetElementById(
      'toggleOutputNameOverride',
    );

    if (outputNameOverrideInput && outputNameOverrideToggle) {
      outputNameOverrideInput.style.display = 'none';
      outputNameOverrideToggle.innerHTML =
        '<i class="codicon codicon-chevron-right"></i>';

      // Update the state
      updateWebviewState({ outputNameOverrideVisible: false });
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

export function initializeOutputContainer() {
  const container = safeGetElementById('outputFilesContainer');
  const toggleIcon = safeGetElementById('toggleOutputFiles');

  if (container && toggleIcon) {
    const state = getWebviewState();
    const shouldShow = state && state.outputFilesActive;

    container.style.display = shouldShow ? 'block' : 'none';
    toggleIcon.innerHTML = shouldShow
      ? '<i class="codicon codicon-chevron-up"></i>'
      : '<i class="codicon codicon-chevron-down"></i>';
  }
}
