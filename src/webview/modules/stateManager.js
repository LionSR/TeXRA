import { getWebviewState, setWebviewState } from './webviewState.js';

import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES_AUTO_EXTRACT,
} from './constants.js';
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
import { capitalize } from './stringUtils.js';

export function setDefaultState() {
  // Hide output name override by default
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleOutputNameOverrideDiv = document.getElementById(
    'toggleOutputNameOverride',
  );
  if (outputNameOverride) outputNameOverride.style.display = 'none';
  if (toggleOutputNameOverrideDiv)
    toggleOutputNameOverrideDiv.textContent = '>';

  // Initialize auto-extract toggle with default state
  const autoExtractToggle = safeGetElementById('toggleAutoExtract');
  const autoExtractOptions = safeGetElementById('autoExtractOptions');
  if (autoExtractToggle && autoExtractOptions) {
    autoExtractToggle.classList.remove('active');
    autoExtractToggle.innerHTML =
      '<i class="codicon codicon-wand"></i><i class="codicon codicon-chevron-down"></i>';
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
  const previousState = getWebviewState();
  if (previousState) {
    const defaultValues = {
      agent: 'correct',
      commit: 'HEAD',
    };

    VALUE_ELEMENTS.forEach((id) => {
      safeSetElementValue(id, previousState[id] ?? defaultValues[id] ?? '');
    });

    CHECK_BOXES.forEach((id) => {
      safeSetElementChecked(id, previousState[id] ?? false);
    });

    // Initialize auto-extract toggle in closed state
    const autoExtractToggle = safeGetElementById('toggleAutoExtract');
    const autoExtractOptions = safeGetElementById('autoExtractOptions');
    const hasAutoExtractChecked = CHECK_BOXES_AUTO_EXTRACT.some((id) =>
      safeGetElementChecked(id),
    );
    if (autoExtractToggle && autoExtractOptions) {
      autoExtractToggle.classList.toggle('active', hasAutoExtractChecked);
      autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="codicon codicon-chevron-down"></i>`;
      autoExtractOptions.style.display = 'none';
    }

    // Initialize tool config toggle state
    const toggleToolConfig = safeGetElementById('toggleToolConfig');
    const toolConfigOptions = safeGetElementById('toolConfigOptions');
    const hasToolConfigChecked = CHECK_BOXES_TOOL_USE.some((id) =>
      safeGetElementChecked(id),
    );
    if (toggleToolConfig && toolConfigOptions) {
      toggleToolConfig.classList.toggle('active', hasToolConfigChecked);
      toggleToolConfig.innerHTML = `<i class="codicon codicon-tools"></i><i class="codicon codicon-chevron-down"></i>`;
      toolConfigOptions.style.display = 'none';
    }

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      const selectDiv = safeGetElementById(id);
      if (!selectDiv) {
        console.warn(`Element with id '${id}' not found`);
        return;
      }
      selectDiv.innerHTML = '';

      // Get files and visibility from state
      const filesArray = previousState[id] ?? [];
      const isVisible = previousState[`${id}Visible`];

      if (filesArray && filesArray.length > 0) {
        filesArray.forEach((file) => {
          addFileToList(id, file);
        });
        setMultipleFileSelectVisibility(
          id,
          toggleId,
          isVisible !== undefined ? isVisible : true,
        );
      } else {
        setMultipleFileSelectVisibility(id, toggleId, false);
      }
    });

    const outputNameOverride = document.getElementById('outputNameOverride');
    const toggleOutputNameOverrideDiv = document.getElementById(
      'toggleOutputNameOverride',
    );
    if (previousState.outputNameOverrideVisible) {
      if (outputNameOverride) outputNameOverride.style.display = 'inline-block';
      if (toggleOutputNameOverrideDiv)
        toggleOutputNameOverrideDiv.textContent = '<';
      safeSetElementValue(
        'outputNameOverride',
        previousState.outputNameOverride ?? '',
      );
    } else {
      if (outputNameOverride) outputNameOverride.style.display = 'none';
      if (toggleOutputNameOverrideDiv)
        toggleOutputNameOverrideDiv.textContent = '>';
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
      safeGetElementById('outputNameOverride')?.style.display ===
      'inline-block',
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

  // Log the state being saved for debugging
  console.log('Saving state:', state);

  setWebviewState(state);
}
