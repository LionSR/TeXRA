// VS Code API
import { vscode } from './vscodeApi.js';

// File handling utilities
import {
  hideEmptyMultipleFileSelects,
  setMultipleFileSelectVisibility,
  addFileToList,
  getSelectedFiles,
} from './fileHandlers.js';

// Common utilities
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
  capitalize,
  uncapitalize,
} from './utils.js';

export function setDefaultState() {
  // Hide output name override by default
  const outputNameOverrideDiv = document.getElementById('outputNameOverride');
  const toggleOutputNameOverrideDiv = document.getElementById(
    'toggleOutputNameOverride',
  );
  outputNameOverrideDiv.style.display = 'none';
  toggleOutputNameOverrideDiv.textContent = '▼';

  // Initialize all multiple file selections to hidden
  MULTIPLE_SELECTIONS.forEach((id) => {
    const toggleId = `toggle${capitalize(id)}`;
    setMultipleFileSelectVisibility(id, toggleId, false);
    const listDiv = safeGetElementById(id);
    if (listDiv) {
      listDiv.innerHTML = '';
    }
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

  const outputNameOverrideDiv = safeGetElementById('outputNameOverride');
  if (outputNameOverrideDiv) {
    state.outputNameOverrideVisible =
      outputNameOverrideDiv.style.display !== 'none';
    state.outputNameOverride = outputNameOverrideDiv.value;
  }

  vscode.setState(state);
}
