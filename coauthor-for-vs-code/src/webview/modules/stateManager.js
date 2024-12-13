import { vscode } from './vscodeApi.js';
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
} from './utils.js';
import {
  hideEmptyMultipleFileSelects,
  setMultipleFileSelectVisibility,
  addFileToList,
  getSelectedFiles,
} from './fileHandlers.js';

export function setDefaultState() {
  // Hide output name override by default
  const outputNameOverride = document.getElementById('outputNameOverride');
  const toggleOutputNameOverride = document.getElementById(
    'toggleOutputNameOverride',
  );
  outputNameOverride.style.display = 'none';
  toggleOutputNameOverride.textContent = '▼';

  // Hide multiple file output by default
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleMultipleOutputFiles = document.getElementById(
    'toggleMultipleOutputFiles',
  );
  outputFilesContainer.style.display = 'none';
  toggleMultipleOutputFiles.textContent = '▼';

  // Clear any existing output files
  document.getElementById('multipleOutputFilesSelect').innerHTML = '';

  // Hide all multiple file select containers
  MULTIPLE_SELECTIONS.forEach((id) => {
    const selectDiv = document.getElementById(id);
    selectDiv.innerHTML = '';
    selectDiv.style.display = 'none';
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    // const selectDiv = document.getElementById(id);
    const toggleId = `toggle1${id.charAt(0).toUpperCase() + id.slice(1)}`;
    console.log('toggleId:', toggleId);

    // const baseId = id.replace('Select', '');
    // const toggleId1 = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
    // console.log('toggleId1:', toggleId1);
    // const toggleIcon = document.getElementById(toggleId1);

    // selectDiv.innerHTML = '';
    // selectDiv.style.display = 'none';
    // toggleIcon.textContent = '▼';
    setMultipleFileSelectVisibility(id, toggleId, false);
    // emptyMultipleFiles(id, toggleId1);
  });

  // Save this default state
  saveState();
}

export function restoreState() {
  const previousState = vscode.getState();
  if (previousState) {
    const defaultValues = {
      agentSelect: 'correct_tex',
      reflectSelect: 'True',
      commitSelect: 'HEAD',
    };

    VALUE_ELEMENTS.forEach((id) => {
      document.getElementById(id).value =
        previousState[id] || defaultValues[id] || '';
    });

    CHECK_BOXES.forEach((id) => {
      document.getElementById(id).checked = previousState[id] || false;
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const baseId = id.replace('Select', '');
      const toggleId = `toggle${baseId.charAt(0).toUpperCase() + baseId.slice(1)}`;
      const selectDiv = document.getElementById(id);
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

    const outputFilesContainer = document.getElementById(
      'outputFilesContainer',
    );
    const toggleIcon = document.getElementById('toggleMultipleOutputFiles');
    if (
      previousState.outputFilesContainerVisible &&
      previousState.outputFiles &&
      previousState.outputFiles.length > 0
    ) {
      outputFilesContainer.style.display = 'block';
      toggleIcon.textContent = '▲';
      const outputFilesDiv = document.getElementById(
        'multipleOutputFilesSelect',
      );
      outputFilesDiv.innerHTML = '';
      previousState.outputFiles.forEach((file) => {
        addFileToList('multipleOutputFilesSelect', file);
      });
    } else {
      outputFilesContainer.style.display = 'none';
      toggleIcon.textContent = '▼';
    }

    const outputNameOverride = document.getElementById('outputNameOverride');
    const toggleOutputNameOverride = document.getElementById(
      'toggleOutputNameOverride',
    );
    if (previousState.outputNameOverrideVisible) {
      outputNameOverride.style.display = 'inline-block';
      toggleOutputNameOverride.textContent = '▲';
      outputNameOverride.value = previousState.outputNameOverride || '';
    } else {
      outputNameOverride.style.display = 'none';
      toggleOutputNameOverride.textContent = '▼';
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
    state[id] = document.getElementById(id).value;
  });
  CHECK_BOXES.forEach((id) => {
    state[id] = document.getElementById(id).checked;
  });

  MULTIPLE_SELECTIONS.forEach((id) => {
    state[`${id}Visible`] =
      document.getElementById(id).style.display === 'block';
    state[id] = getSelectedFiles(document.getElementById(id));
  });

  state.outputFilesContainerVisible =
    document.getElementById('outputFilesContainer').style.display === 'block';
  state.outputFiles = getSelectedFiles(
    document.getElementById('multipleOutputFilesSelect'),
  );
  state.outputNameOverrideVisible =
    document.getElementById('outputNameOverride').style.display !== 'none';

  vscode.setState(state);
}
