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
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleOutputNameOverrideDiv = document.getElementById('toggleOutputNameOverride');
  if (outputNameOverride) outputNameOverride.style.display = 'none';
  if (toggleOutputNameOverrideDiv) toggleOutputNameOverrideDiv.textContent = '>';

  // Initialize auto-extract toggle with empty circle
  const autoExtractToggle = safeGetElementById('toggleAutoExtract');
  const autoExtractOptions = safeGetElementById('autoExtractOptions');
  if (autoExtractToggle && autoExtractOptions) {
    autoExtractToggle.innerHTML =
      'Auto ○<i class="fa-solid fa-angle-down"></i>';
    autoExtractOptions.style.display = 'none';
  }

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

    // Initialize auto-extract toggle in closed state
    const autoExtractToggle = safeGetElementById('toggleAutoExtract');
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const hasChecked = [
      'autoExtractFigure',
      'autoExtractTikzFigure',
      'autoExtractTikzFigureReflect',
    ].some((id) => safeGetElementChecked(id));
    const indicator = hasChecked ? '●' : '○';

    autoExtractToggle.classList.remove('active');
    autoExtractToggle.innerHTML = `Auto ${indicator}<i class="fa-solid fa-angle-down"></i>`;
    autoExtractOptions.style.display = 'none';

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

    const outputNameOverride = document.getElementById('outputNameOverride');
    const toggleOutputNameOverrideDiv = document.getElementById('toggleOutputNameOverride');
    if (previousState.outputNameOverrideVisible) {
      if (outputNameOverride) outputNameOverride.style.display = 'inline-block';
      if (toggleOutputNameOverrideDiv) toggleOutputNameOverrideDiv.textContent = '<';
      safeSetElementValue('outputNameOverride', previousState.outputNameOverride || '');
    } else {
      if (outputNameOverride) outputNameOverride.style.display = 'none';
      if (toggleOutputNameOverrideDiv) toggleOutputNameOverrideDiv.textContent = '>';
    }
  } else {
    // If there's no previous state, set to default
    setDefaultState();
  }

  // Hide empty multiple file select boxes
  hideEmptyMultipleFileSelects();
}

export function saveState() {
  const state = {
    outputNameOverrideVisible:
      safeGetElementById('outputNameOverride')?.style.display === 'inline-block',
    outputNameOverride: safeGetElementValue('outputNameOverride'),
  };

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

  vscode.setState(state);
}
