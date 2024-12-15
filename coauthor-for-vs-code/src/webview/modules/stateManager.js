import { vscode } from './vscodeApi.js';
import { MULTIPLE_SELECTIONS, CHECK_BOXES, VALUE_ELEMENTS } from './utils.js';
import {
  hideEmptyMultipleFileSelects,
  setMultipleFileSelectVisibility,
  addFileToList,
  getSelectedFiles,
} from './fileHandlers.js';
import {
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
} from './utils.js';
import { capitalize, uncapitalize } from './utils.js';

export function setDefaultState() {
  // Hide output name override by default
  const outputNameOverrideDiv = document.getElementById('outputNameOverride');
  const toggleOutputNameOverrideDiv = document.getElementById(
    'toggleOutputNameOverride',
  );
  outputNameOverrideDiv.style.display = 'none';
  toggleOutputNameOverrideDiv.textContent = '▼';

  // Hide multiple file output by default
  const outputFilesContainerDiv = document.getElementById(
    'outputFilesContainer',
  );
  const toggleMultipleOutputFilesDiv = document.getElementById(
    'toggleMultipleOutputFiles',
  );
  outputFilesContainerDiv.style.display = 'none';
  toggleMultipleOutputFilesDiv.textContent = '▼';
  document.getElementById('multipleOutputFiles').innerHTML = '';

  MULTIPLE_SELECTIONS.forEach((id) => {
    const toggleId = `toggle${capitalize(id)}`;
    setMultipleFileSelectVisibility(id, toggleId, false);
  });

  saveState();
}

export function restoreState() {
  const previousState = vscode.getState();
  if (previousState) {
    const defaultValues = {
      agent: 'correct_tex',
      reflect: 'True',
      commit: 'HEAD',
    };

    VALUE_ELEMENTS.forEach((id) => {
      safeSetElementValue(id, previousState[id] || defaultValues[id] || '');
    });

    CHECK_BOXES.forEach((id) => {
      safeSetElementChecked(id, previousState[id] || false);
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const selectDiv = safeGetElementById(id);
      if (!selectDiv) {
        console.warn(`Element with id '${id}' not found`);
        return;
      }
      selectDiv.innerHTML = '';
      if (previousState[id] && previousState[id].length > 0) {
        previousState[id].forEach((file) => {
          addFileToList(id, file);
        });
        setMultipleFileSelectVisibility(
          id,
          toggleId,
          previousState[`${id}Visible`],
        );
      } else {
        setMultipleFileSelectVisibility(id, toggleId, false);
      }
    });

    const outputFilesContainerDiv = document.getElementById(
      'outputFilesContainer',
    );
    const toggleIconDiv = document.getElementById('toggleMultipleOutputFiles');

    if (
      previousState.outputFilesContainerVisible &&
      previousState.outputFiles &&
      previousState.outputFiles.length > 0
    ) {
      outputFilesContainerDiv.style.display = 'block';
      toggleIconDiv.textContent = '▲';
      const outputFilesDiv = document.getElementById('multipleOutputFiles');
      outputFilesDiv.innerHTML = '';
      previousState.outputFiles.forEach((file) => {
        addFileToList('multipleOutputFiles', file);
      });
    } else {
      outputFilesContainerDiv.style.display = 'none';
      toggleIconDiv.textContent = '▼';
    }

    const outputNameOverrideDiv = document.getElementById('outputNameOverride');
    const toggleOutputNameOverrideDiv = document.getElementById(
      'toggleOutputNameOverride',
    );
    if (previousState.outputNameOverrideVisible) {
      outputNameOverrideDiv.style.display = 'inline-block';
      toggleOutputNameOverrideDiv.textContent = '▲';
      outputNameOverrideDiv.value = previousState.outputNameOverride || '';
    } else {
      outputNameOverrideDiv.style.display = 'none';
      toggleOutputNameOverrideDiv.textContent = '▼';
    }
  } else {
    // If there's no previous state, set to default
    setDefaultState();
  }

  // Hide empty multiple file select boxes
  hideEmptyMultipleFileSelects();
}

export function saveState() {
  const state = {};

  VALUE_ELEMENTS.forEach((id) => {
    const value = safeGetElementValue(id);
    if (value !== undefined) {
      state[id] = value;
    }
  });

  CHECK_BOXES.forEach((id) => {
    state[id] = safeGetElementChecked(id);
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    const elementDiv = safeGetElementById(id);
    if (!elementDiv) return;
    const containerDiv = safeGetElementById(`${id}Container`);
    state[`${id}Visible`] =
      containerDiv && containerDiv.style.display === 'block';
    state[id] = getSelectedFiles(elementDiv);
  });

  const outputFilesContainerDiv = safeGetElementById('outputFilesContainer');
  const multipleOutputFilesDiv = safeGetElementById('multipleOutputFiles');
  const outputNameOverrideDiv = safeGetElementById('outputNameOverride');

  if (outputFilesContainerDiv) {
    state.outputFilesContainerVisible =
      outputFilesContainerDiv.style.display === 'block';
  }

  if (multipleOutputFilesDiv) {
    state.outputFiles = getSelectedFiles(multipleOutputFilesDiv);
  }

  if (outputNameOverrideDiv) {
    state.outputNameOverrideVisible =
      outputNameOverrideDiv.style.display !== 'none';
    state.outputNameOverride = outputNameOverrideDiv.value;
  }

  vscode.setState(state);
}
