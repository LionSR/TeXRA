const vscode = acquireVsCodeApi();

function handleCheckboxChange(event) {
  const checkboxId = event.target.id;
  const isChecked = event.target.checked;
  vscode.postMessage({ command: `update${checkboxId.charAt(0).toUpperCase() + checkboxId.slice(1)}`, value: isChecked });
}

function updateFileSelect(selectId, files) {
  const select = document.getElementById(selectId);
  select.innerHTML = '<option value="">None</option>';
  files.forEach(file => {
    select.appendChild(new Option(file, file));
  });
}

function addFileToList(containerId, file) {
  const container = document.getElementById(containerId);
  const fileElement = document.createElement('div');
  fileElement.textContent = file;
  const removeButton = document.createElement('span');
  removeButton.textContent = ' -';
  removeButton.className = 'remove-button';
  removeButton.addEventListener('click', () => {
    container.removeChild(fileElement);
    if (container.children.length === 0) {
      if (containerId === 'outputFilesList') {
        handleEmptyOutputFiles();
      } else {
        container.style.display = 'none';
      }
    }
    saveState();
  });
  fileElement.appendChild(removeButton);
  container.appendChild(fileElement);
}

function handleEmptyOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleOutputFiles');
  outputFilesContainer.style.display = 'none';
  toggleIcon.textContent = '▼';
  saveState();
}

function getSelectedFiles(multipleInputFilesSelectDiv) {
  const fileElements = multipleInputFilesSelectDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(el => el.textContent.replace(' -', '') || '');
}

function updateMultipleFileSelect(selectId, files) {
  const selectDiv = document.getElementById(selectId);
  selectDiv.style.display = 'none'; // Hide by default
  selectDiv.innerHTML = ''; // Clear any existing content
  const existingFiles = getSelectedFiles(selectDiv);
  const newFiles = files.filter(file => !existingFiles.includes(file));
  if (newFiles.length > 0) {
    newFiles.forEach(file => {
      addFileToList(selectId, file);
    });
    selectDiv.style.display = 'block';
  } else {
    selectDiv.style.display = 'none';
  }
  saveState();
}

function initializeOutputFiles() {
  const inputFileSelect = document.getElementById('inputFileSelect');
  const multipleInputFilesSelect = document.getElementById('multipleInputFilesSelect');
  const outputFilesList = document.getElementById('outputFilesList');
  outputFilesList.innerHTML = '';
  
  // Add the main input file
  if (inputFileSelect.value) {
    addFileToList('outputFilesList', inputFileSelect.value);
  }
  
  // Add multiple input files
  const additionalFiles = getSelectedFiles(multipleInputFilesSelect);
  additionalFiles.forEach(file => {
    addFileToList('outputFilesList', file);
  });
}

function toggleOutputFiles() {
  const outputFilesContainer = document.getElementById('outputFilesContainer');
  const toggleIcon = document.getElementById('toggleOutputFiles');
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

function toggleOutputNameOverride() {
  const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
  const toggleIcon = document.getElementById('toggleOutputNameOverride');
  if (outputNameOverrideContainer.style.display === 'none') {
    outputNameOverrideContainer.style.display = 'block';
    toggleIcon.textContent = '▲';
  } else {
    outputNameOverrideContainer.style.display = 'none';
    toggleIcon.textContent = '▼';
  }
  saveState();
}

window.onload = function () {
  const dataRequests = [
    'getTheme',
    'requestInputFile',
    'requestSampleFile',
    'requestAuxFile',
    'requestFigureFile',
    'requestRecentCommits',
  ];

  dataRequests.forEach(request => {
    vscode.postMessage({ command: request });
  });
};

document.addEventListener('DOMContentLoaded', function () {
  const sortableElements = [
    'multipleInputFilesSelect',
    'multipleAuxFilesSelect',
    'multipleFiguresSelect',
    'multipleSampleFilesSelect'
  ];

  sortableElements.forEach(id => {
    new Sortable(document.getElementById(id), {
      animation: 150,
      onEnd: saveState
    });
  });

  document.getElementById('taskSelect').addEventListener('change', function () {
    const selectedTask = this.value;
    if (selectedTask.startsWith('correct')) {
      document.getElementById('figureFileSelect').value = '';
      document.getElementById('reflectSelect').value = 'False';
    } else {
      // Refresh the figure file options
      vscode.postMessage({ command: 'requestFigureFile' });
    }
    saveState();
  });
  document.getElementById('modelSelect').addEventListener('change', function () {
    vscode.postMessage({
      command: 'modelSelected',
      model: this.value
    });
  });
  document.getElementById('inputFileSelect').addEventListener('change', function () {
    const inputFile = this.value;
    const outputNameOverride = document.getElementById('outputNameOverrideContainer').style.display === 'block'
      ? document.getElementById('outputNameOverride').value
      : null;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('sampleFileSelect').addEventListener('change', function () {
    const sampleFile = this.value;
    vscode.postMessage({
      command: 'sampleFileSelected',
      filePath: sampleFile
    });
  });
  document.getElementById('selectMultipleInputFilesButton').addEventListener('click', function () {
    const currentInputFile = document.getElementById('inputFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleInputFiles',
      currentInputFile: currentInputFile
    });
  });
  document.getElementById('selectMultipleSampleFilesButton').addEventListener('click', function () {
    const currentSampleFile = document.getElementById('sampleFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleSampleFiles',
      currentSampleFile: currentSampleFile
    });
  });
  document.getElementById('selectMultipleAuxFilesButton').addEventListener('click', function () {
    const currentAuxFile = document.getElementById('auxFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleAuxFiles',
      currentAuxFile: currentAuxFile
    });
  });
  document.getElementById('selectMultipleFiguresButton').addEventListener('click', function () {
    const currentFigureFile = document.getElementById('figureFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleFigures',
      currentFigureFile: currentFigureFile
    });
  });

  document.getElementById('emptyMultipleInputFilesButton').addEventListener('click', function () {
    const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
    multipleInputFilesSelectDiv.innerHTML = '';
    multipleInputFilesSelectDiv.style.display = 'none';
    // Also clear and hide the output files list
    const outputFilesList = document.getElementById('outputFilesList');
    outputFilesList.innerHTML = '';
    handleEmptyOutputFiles();
    saveState();
  });
  document.getElementById('emptyMultipleAuxFilesButton').addEventListener('click', function () {
    const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
    multipleAuxFilesSelectDiv.innerHTML = '';
    multipleAuxFilesSelectDiv.style.display = 'none';
    saveState();
  });
  document.getElementById('emptyMultipleSampleFilesButton').addEventListener('click', function () {
    const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
    multipleSampleFilesSelectDiv.innerHTML = '';
    multipleSampleFilesSelectDiv.style.display = 'none';
    saveState();
  });
  document.getElementById('emptyMultipleFiguresButton').addEventListener('click', function () {
    const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
    multipleFiguresSelectDiv.innerHTML = '';
    multipleFiguresSelectDiv.style.display = 'none';
    document.getElementById('figureFileSelect').value = '';
    saveState();
  });
  document.getElementById('emptyInstructionsButton').addEventListener('click', function () {
    document.getElementById('taskInput').value = '';
    saveState();
  });

  const checkBoxes = [
    'autoExtractFigure',
    'autoExtractTikzFigure',
    'includeTikzReflection',
    'includeTexCount'
  ];
  checkBoxes.forEach(id => {
    document.getElementById(id).addEventListener('change', handleCheckboxChange);
  });

  const buttonCommands = {
    'cleanOutputButton': 'cleanOutput',
    'cleanBuildButton': 'cleanBuild',
    'indentTexButton': 'indentTex',
    'refreshCommitsButton': 'refreshCommits',
    'currentFileButton': 'getCurrentFile'
  };

  Object.entries(buttonCommands).forEach(([id, command]) => {
    document.getElementById(id).addEventListener('click', () => {
      vscode.postMessage({ command });
    });
  });

  document.getElementById('executeButton').addEventListener('click', function () {
    const task = document.getElementById('taskSelect').value;
    const inputFile = document.getElementById('inputFileSelect').value;
    const sampleFile = document.getElementById('sampleFileSelect').value;
    const auxFile = document.getElementById('auxFileSelect').value;
    const figureFile = document.getElementById('figureFileSelect').value;
    const instructions = document.getElementById('taskInput').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const autoExtractFigure = document.getElementById('autoExtractFigure').checked;
    const autoExtractTikzFigure = document.getElementById('autoExtractTikzFigure').checked;
    const includeTikzReflection = document.getElementById('includeTikzReflection').checked;
    const includeTexCount = document.getElementById('includeTexCount').checked;

    // Get additional input files
    const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
    const additionalInputFiles = getSelectedFiles(multipleInputFilesSelectDiv).filter(file => file !== inputFile);

    // Get sample files
    const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
    const multipleSampleFiles = getSelectedFiles(multipleSampleFilesSelectDiv);
    const sampleFiles = multipleSampleFiles.length > 0 ? multipleSampleFiles : (sampleFile ? [sampleFile] : []);

    // Get auxiliary files
    const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
    const multipleAuxFiles = getSelectedFiles(multipleAuxFilesSelectDiv);
    const auxFiles = multipleAuxFiles.length > 0 ? multipleAuxFiles : (auxFile ? [auxFile] : []);

    // Get figure files
    const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
    const multipleFigures = getSelectedFiles(multipleFiguresSelectDiv);
    const figureFiles = multipleFigures.length > 0 ? multipleFigures : (figureFile ? [figureFile] : []);

    const outputFilesContainer = document.getElementById('outputFilesContainer');
    const outputFiles = outputFilesContainer.style.display === 'block' 
      ? getSelectedFiles(document.getElementById('outputFilesList'))
      : null;
    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const outputNameOverride = outputNameOverrideContainer.style.display === 'block' 
      ? document.getElementById('outputNameOverride').value
      : null;

    vscode.postMessage({
      command: 'execute',
      task: task,
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      sampleFiles: sampleFiles,
      auxFiles: auxFiles,
      figureFiles: figureFiles,
      instructions: instructions,
      reflect: reflect,
      model: model,
      autoExtractFigure: autoExtractFigure,
      autoExtractTikzFigure: autoExtractTikzFigure,
      includeTikzReflection: includeTikzReflection,
      includeTexCount: includeTexCount,
      outputFiles: outputFiles,
      outputNameOverride: outputNameOverride,
    });
  });
  document.getElementById('packSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const outputNameOverride = outputNameOverrideContainer.style.display === 'block' 
      ? document.getElementById('outputNameOverride').value
      : null;
    vscode.postMessage({
      command: 'packSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('cleanSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const outputNameOverride = outputNameOverrideContainer.style.display === 'block' 
      ? document.getElementById('outputNameOverride').value
      : null;
    vscode.postMessage({
      command: 'cleanSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('latexDiffButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const editedFile = document.getElementById('editedFileSelect').value;
    vscode.postMessage({
      command: 'latexDiff',
      inputFile: inputFile,
      editedFile: editedFile
    });
  });
  document.getElementById('latexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'latexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash
    });
  });
  document.getElementById('packLatexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'packLatexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash,
      clean: false
    });
  });
  document.getElementById('cleanLatexDiffVCButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const commitHash = document.getElementById('commitSelect').value;
    vscode.postMessage({
      command: 'packLatexDiffVC',
      inputFile: inputFile,
      commitHash: commitHash,
      clean: true
    });
  });
  document.getElementById('currentEditedFileButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const outputNameOverride = document.getElementById('outputNameOverrideContainer').style.display === 'block'
      ? document.getElementById('outputNameOverride').value
      : null;
    vscode.postMessage({
      command: 'requestEditedFile',
      inputFile: inputFile,
      outputNameOverride: outputNameOverride
    });
  });
  document.getElementById('mergeButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const editedFile = document.getElementById('editedFileSelect').value;
    vscode.postMessage({
      command: 'merge',
      inputFile: inputFile,
      editedFile: editedFile
    });
  });

  // Save state on input changes
  const elementsToWatch = [
    'modelSelect', 'taskSelect', 'inputFileSelect', 'sampleFileSelect',
    'auxFileSelect', 'figureFileSelect', 'reflectSelect',
    'commitSelect', 'autoExtractFigure', 'autoExtractTikzFigure',
    'includeTikzReflection', 'includeTexCount'
  ];

  elementsToWatch.forEach(id => {
    document.getElementById(id).addEventListener('change', saveState);
  });

  // Special case for taskInput as it uses 'input' event
  document.getElementById('taskInput').addEventListener('input', saveState);

  document.getElementById('toggleOutputFiles').addEventListener('click', toggleOutputFiles);

  new Sortable(document.getElementById('outputFilesList'), {
    animation: 150,
    onEnd: saveState
  });

  document.getElementById('outputNameOverride').addEventListener('input', saveState);

  document.getElementById('toggleOutputNameOverride').addEventListener('click', toggleOutputNameOverride);

  // Add these event listeners
  document.getElementById('packMultipleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const additionalInputFiles = getSelectedFiles(document.getElementById('multipleInputFilesSelect'));
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const outputNameOverride = outputNameOverrideContainer.style.display === 'block' 
      ? document.getElementById('outputNameOverride').value
      : null;
    const outputFiles = getSelectedFiles(document.getElementById('outputFilesList'));
    
    vscode.postMessage({
      command: 'packMultiple',
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride,
      outputFiles: outputFiles
    });
  });

  document.getElementById('cleanMultipleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const additionalInputFiles = getSelectedFiles(document.getElementById('multipleInputFilesSelect'));
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const outputNameOverride = outputNameOverrideContainer.style.display === 'block' 
      ? document.getElementById('outputNameOverride').value
      : null;
    const outputFiles = getSelectedFiles(document.getElementById('outputFilesList'));
    
    vscode.postMessage({
      command: 'cleanMultiple',
      inputFile: inputFile,
      additionalInputFiles: additionalInputFiles,
      task: task,
      reflect: reflect,
      model: model,
      outputNameOverride: outputNameOverride,
      outputFiles: outputFiles
    });
  });
});

function saveState() {
  const state = {
    modelSelect: document.getElementById('modelSelect').value,
    taskSelect: document.getElementById('taskSelect').value,
    inputFileSelect: document.getElementById('inputFileSelect').value,
    sampleFileSelect: document.getElementById('sampleFileSelect').value,
    auxFileSelect: document.getElementById('auxFileSelect').value,
    figureFileSelect: document.getElementById('figureFileSelect').value,
    taskInput: document.getElementById('taskInput').value,
    reflectSelect: document.getElementById('reflectSelect').value,
    commitSelect: document.getElementById('commitSelect').value,
    autoExtractFigure: document.getElementById('autoExtractFigure').checked,
    autoExtractTikzFigure: document.getElementById('autoExtractTikzFigure').checked,
    includeTikzReflection: document.getElementById('includeTikzReflection').checked,
    includeTexCount: document.getElementById('includeTexCount').checked,
    multipleInputFilesSelect: getSelectedFiles(document.getElementById('multipleInputFilesSelect')),
    multipleSampleFilesSelect: getSelectedFiles(document.getElementById('multipleSampleFilesSelect')),
    multipleAuxFilesSelect: getSelectedFiles(document.getElementById('multipleAuxFilesSelect')),
    multipleFiguresSelect: getSelectedFiles(document.getElementById('multipleFiguresSelect')),
    outputFilesContainerVisible: document.getElementById('outputFilesContainer').style.display === 'block',
    outputFiles: getSelectedFiles(document.getElementById('outputFilesList')),
    outputNameOverrideVisible: document.getElementById('outputNameOverrideContainer').style.display === 'block',
    outputNameOverride: document.getElementById('outputNameOverride').value,
  };
  vscode.setState(state);
}

function restoreState() {
  const previousState = vscode.getState();
  if (previousState) {
    const defaultValues = {
      taskSelect: 'correct-tex',
      reflectSelect: 'True',
      commitSelect: 'HEAD'
    };

    const valueElements = [
      'modelSelect', 'taskSelect', 'inputFileSelect', 'auxFileSelect',
      'figureFileSelect', 'sampleFileSelect', 'editedFileSelect',
      'taskInput', 'reflectSelect', 'commitSelect', 'outputNameOverride'
    ];

    valueElements.forEach(id => {
      document.getElementById(id).value = previousState[id] || defaultValues[id] || '';
    });

    const checkboxElements = [
      'autoExtractFigure', 'autoExtractTikzFigure',
      'includeTikzReflection', 'includeTexCount'
    ];
    checkboxElements.forEach(id => {
      document.getElementById(id).checked = previousState[id] || false;
    });

    const multipleSelections = [
      'multipleInputFilesSelect',
      'multipleSampleFilesSelect',
      'multipleAuxFilesSelect',
      'multipleFiguresSelect'
    ];

    multipleSelections.forEach(id => {
      const selectDiv = document.getElementById(id);
      selectDiv.innerHTML = '';
      selectDiv.style.display = 'none'; // Hide by default
      if (previousState[id] && previousState[id].length > 0) {
        previousState[id].forEach(file => {
          addFileToList(id, file);
        });
        selectDiv.style.display = 'block';
      } else {
        selectDiv.style.display = 'none';
      }
    });

    const outputFilesContainer = document.getElementById('outputFilesContainer');
    const toggleIcon = document.getElementById('toggleOutputFiles');
    if (previousState.outputFilesContainerVisible && previousState.outputFiles && previousState.outputFiles.length > 0) {
      outputFilesContainer.style.display = 'block';
      toggleIcon.textContent = '▲';
      const outputFilesList = document.getElementById('outputFilesList');
      outputFilesList.innerHTML = '';
      previousState.outputFiles.forEach(file => {
        addFileToList('outputFilesList', file);
      });
    } else {
      outputFilesContainer.style.display = 'none';
      toggleIcon.textContent = '▼';
    }

    const outputNameOverrideContainer = document.getElementById('outputNameOverrideContainer');
    const toggleOutputNameOverride = document.getElementById('toggleOutputNameOverride');
    if (previousState.outputNameOverrideVisible) {
      outputNameOverrideContainer.style.display = 'block';
      toggleOutputNameOverride.textContent = '▲';
      document.getElementById('outputNameOverride').value = previousState.outputNameOverride || '';
    } else {
      outputNameOverrideContainer.style.display = 'none';
      toggleOutputNameOverride.textContent = '▼';
    }
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  switch (message.command) {
    case 'setInputFile':
      updateFileSelect('inputFileSelect', message.files);
      break;
    case 'setSampleFile':
      updateFileSelect('sampleFileSelect', message.files);
      break;
    case 'setAuxFile':
      updateFileSelect('auxFileSelect', message.files);
      break;
    case 'setFigureFile':
      updateFileSelect('figureFileSelect', message.files);
      break;
    case 'setMultipleInputFiles':
      updateMultipleFileSelect('multipleInputFilesSelect', message.files);
      break;
    case 'setMultipleSampleFiles':
      updateMultipleFileSelect('multipleSampleFilesSelect', message.files);
      break;
    case 'setMultipleAuxFiles':
      updateMultipleFileSelect('multipleAuxFilesSelect', message.files);
      break;
    case 'setMultipleFigures':
      updateMultipleFileSelect('multipleFiguresSelect', message.files);
      break;
    case 'setEditedFiles':
      updateFileSelect('editedFileSelect', message.files);
      break;
    case 'inputFileSelected':
      document.getElementById('inputFileSelect').value = message.filePath;
      vscode.postMessage({
        command: 'requestEditedFile',
        inputFile: message.filePath,
        outputNameOverride: message.outputNameOverride
      });
      break;
    case 'sampleFileSelected':
      document.getElementById('sampleFileSelect').value = message.filePath;
      break;
    case 'auxFileSelected':
      document.getElementById('auxFileSelect').value = message.filePath;
      break;
    case 'figureFileSelected':
      document.getElementById('figureFileSelect').value = message.filePath;
      // Clear multiple figures selection when a single figure file is selected
      document.getElementById('multipleFiguresSelect').innerHTML = '';
      document.getElementById('multipleFiguresSelect').style.display = 'none';
      break;
    case 'editedFileSelected':
      document.getElementById('editedFileSelect').value = message.filePath;
      break;
    case 'modelSelected':
      document.getElementById('modelSelect').value = message.model;
      break;
    case 'setRecentCommits':
      const commitButtons = [
        'packLatexDiffVCButton',
        'cleanLatexDiffVCButton',
        'latexDiffVCButton'
      ];
      const commitSelect = document.getElementById('commitSelect');
      commitSelect.innerHTML = '';
      if (message.isGitRepo === false) {
        const option = document.createElement('option');
        option.value = '';
        option.textContent = 'Not a Git repository';
        commitSelect.appendChild(option);
        commitSelect.disabled = true;
        commitButtons.forEach(id => {
          document.getElementById(id).disabled = true;
        });
      } else {
        const emptyCommitOption = document.createElement('option');
        emptyCommitOption.value = 'HEAD';
        emptyCommitOption.textContent = 'HEAD';
        commitSelect.appendChild(emptyCommitOption);
        message.commits.forEach(commit => {
          const option = document.createElement('option');
          const [commitHash, ...commitMessageParts] = commit.split(': ');
          const commitMessage = commitMessageParts.join(': '); // Rejoin in case the commit message contained ': '
          option.value = commitHash;
          option.textContent = commit;
          commitSelect.appendChild(option);
        });
        commitSelect.disabled = false;
        commitButtons.forEach(id => {
          document.getElementById(id).disabled = false;
        });
      }
      break;
    case 'setCurrentFile':
      const inputFileSelect_val = document.getElementById('inputFileSelect');
      const options = Array.from(inputFileSelect_val.options);
      const matchingOption = options.find(option => option.value === message.filePath);
      if (matchingOption) {
        inputFileSelect_val.value = message.filePath;
        // Trigger change event to update related fields
        inputFileSelect_val.dispatchEvent(new Event('change'));
      } else {
        // Print the name of the current file,
        vscode.window.showInformationMessage('The current file is not in the input file list: ' + message.filePath);
      }
      break;
    case 'setTheme':
      document.body.className = message.theme;
      break;
  }
  
  // Restore previous state
  restoreState();
});
