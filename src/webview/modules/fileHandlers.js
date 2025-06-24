import { vscode } from '@common/webviewContext.js';
import { webviewState } from './webviewState.js';
import { fileList } from './uiManagers/FileList.js';
import { fileSelect } from './uiManagers/FileSelect.js';
import { safeGetElementById } from '@common/domUtils.js';
import {
  CHEVRON_UP_CLASS,
  CHEVRON_DOWN_CLASS,
} from '@common/webviewContext.js';
import { capitalize } from '@common/stringUtils.js';

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
  const state = webviewState.get();

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
        fileList.add('outputFiles', file);
      });
    } else if (
      fileSelect.getAgentDefaultOutputFiles().length > 0 &&
      (!state.outputFiles || state.outputFiles.length === 0)
    ) {
      // Use agent default output files if provided
      outputFilesDiv.innerHTML = '';
      fileSelect.getAgentDefaultOutputFiles().forEach((file) => {
        fileList.add('outputFiles', file);
      });
    } else {
      // Clear the list
      outputFilesDiv.innerHTML = '';

      // Add the current input file as output
      fileList.add('outputFiles', inputFileDiv.value);

      // Also add any input files from the multiple input files list
      if (state.inputFiles && state.inputFiles.length > 0) {
        state.inputFiles.forEach((file) => {
          if (file !== inputFile) {
            // Avoid duplicates
            fileList.add('outputFiles', file);
          }
        });
      }
    }
  } else if (outputFilesDiv) {
    // If we don't have an input file, just clear the output files list
    outputFilesDiv.innerHTML = '';
  }

  // Add opened files to the output files list
  const openedFiles = webviewState.get()?.openedFiles ?? [];
  openedFiles.forEach((file) => {
    fileList.add('outputFiles', file);
  });

  // Output filename override removed

  webviewState.save();
}

export function toggleOutputFiles() {
  const containerVisible =
    safeGetElementById('outputFilesContainer').style.display !== 'none';

  if (containerVisible) {
    fileList.toggle('outputFiles', 'toggleOutputFiles');
  } else {
    initializeOutputFiles();
    fileList.toggle('outputFiles', 'toggleOutputFiles');
  }
}

export function initializeOutputContainer() {
  const container = safeGetElementById('outputFilesContainer');
  const toggleIcon = safeGetElementById('toggleOutputFiles');

  if (container && toggleIcon) {
    const state = webviewState.get();
    const shouldShow = state && state.outputFilesActive;

    container.style.display = shouldShow ? 'block' : 'none';
    toggleIcon.innerHTML = `<i class="${
      shouldShow ? CHEVRON_UP_CLASS : CHEVRON_DOWN_CLASS
    }"></i>`;
  }
}

export function initializeLatexdiffsSection() {
  const container = safeGetElementById('latexdiffsContent');
  const toggleIcon = safeGetElementById('toggleLatexdiffs');

  if (container && toggleIcon) {
    const state = webviewState.get();
    const shouldShow = state && state.latexdiffsVisible;

    container.style.display = shouldShow ? 'block' : 'none';

    // Update the icon class instead of replacing innerHTML
    const iconElement = toggleIcon.querySelector('i');
    if (iconElement) {
      iconElement.className = shouldShow
        ? CHEVRON_UP_CLASS
        : CHEVRON_DOWN_CLASS;
    }
  }
}

export function toggleLatexdiffs() {
  const container = safeGetElementById('latexdiffsContent');
  const toggleIcon = safeGetElementById('toggleLatexdiffs');
  if (!container || !toggleIcon) return;

  const isVisible = container.style.display !== 'none';
  container.style.display = isVisible ? 'none' : 'block';

  // Update the icon class instead of replacing innerHTML to preserve the title
  const iconElement = toggleIcon.querySelector('i');
  if (iconElement) {
    iconElement.className = isVisible ? CHEVRON_DOWN_CLASS : CHEVRON_UP_CLASS;
  }

  webviewState.update({ latexdiffsVisible: !isVisible });
  webviewState.save();
}
