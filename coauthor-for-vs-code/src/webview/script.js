const vscode = acquireVsCodeApi();

function addFileToList(containerId, file) {
  const container = document.getElementById(containerId);
  const fileElement = document.createElement('div');
  fileElement.textContent = file;
  const removeButton = document.createElement('span');
  removeButton.textContent = ' -';
  removeButton.className = 'remove-button';
  removeButton.addEventListener('click', () => {
    container.removeChild(fileElement);
    saveState();
  });
  fileElement.appendChild(removeButton);
  container.appendChild(fileElement);
}

function getSelectedFiles(multipleInputFilesSelectDiv) {
  const fileElements = multipleInputFilesSelectDiv.getElementsByTagName('div');
  return Array.from(fileElements).map(el => el.textContent.replace(' -', '') || '');
}

window.onload = function () {
  vscode.postMessage({ command: 'requestInputFile' });
  vscode.postMessage({ command: 'requestSampleFile' });
  vscode.postMessage({ command: 'requestAuxFile' });
  vscode.postMessage({ command: 'requestFigureFile' });
  vscode.postMessage({ command: 'requestEditedFile' });
  vscode.postMessage({ command: 'requestRecentCommits' });
  // Restore previous state
  restoreState();
};
document.addEventListener('DOMContentLoaded', function () {
  new Sortable(document.getElementById('multipleInputFilesSelect'), {
    animation: 150,
    onEnd: function () {
      saveState();
    }
  });

  // Initialize Sortable for multiple auxiliary files
  new Sortable(document.getElementById('multipleAuxFilesSelect'), {
    animation: 150,
    onEnd: function () {
      saveState();
    }
  });

  // Initialize Sortable for multiple figures
  new Sortable(document.getElementById('multipleFiguresSelect'), {
    animation: 150,
    onEnd: function () {
      saveState();
    }
  });

  // Initialize Sortable for multiple sample files
  new Sortable(document.getElementById('multipleSampleFilesSelect'), {
    animation: 150,
    onEnd: function () {
      saveState();
    }
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
      command: 'modelSelect',
      model: this.value
    });
  });
  document.getElementById('inputFileSelect').addEventListener('change', function () {
    const inputFile = this.value;
    vscode.postMessage({
      command: 'inputFileSelected',
      filePath: inputFile
    });
  });
  document.getElementById('sampleFileSelect').addEventListener('change', function () {
    const sampleFile = this.value;
    vscode.postMessage({
      command: 'sampleFileSelected',
      filePath: sampleFile
    });
  });
  document.getElementById('selectMultipleFilesButton').addEventListener('click', function () {
    const currentInputFile = document.getElementById('inputFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleFiles',
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
    vscode.postMessage({
      command: 'selectMultipleAuxFiles'
    });
  });
  document.getElementById('selectMultipleFiguresButton').addEventListener('click', function () {
    const currentFigureFile = document.getElementById('figureFileSelect').value;
    vscode.postMessage({
      command: 'selectMultipleFigures',
      currentFigureFile: currentFigureFile
    });
  });
  document.getElementById('emptyMultipleFilesButton').addEventListener('click', function () {
    const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
    multipleInputFilesSelectDiv.innerHTML = '';
    multipleInputFilesSelectDiv.style.display = 'none';
    saveState();
  });
  document.getElementById('emptyMultipleAuxFilesButton').addEventListener('click', function () {
    const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
    multipleAuxFilesSelectDiv.innerHTML = '';
    multipleAuxFilesSelectDiv.style.display = 'none';
    saveState();
  });
  document.getElementById('emptyMultipleFiguresButton').addEventListener('click', function () {
    const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
    multipleFiguresSelectDiv.innerHTML = '';
    multipleFiguresSelectDiv.style.display = 'none';

    // Set the single figure file select to "None"
    document.getElementById('figureFileSelect').value = '';
    saveState();
  });
  document.getElementById('emptyMultipleSampleFilesButton').addEventListener('click', function () {
    const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
    multipleSampleFilesSelectDiv.innerHTML = '';
    multipleSampleFilesSelectDiv.style.display = 'none';
    saveState();
  });
  document.getElementById('emptyInstructionsButton').addEventListener('click', function () {
    document.getElementById('taskInput').value = '';
    saveState();
  });
  document.getElementById('autoExtractFigure').addEventListener('change', (event) => {
    const isChecked = event.target.checked;
    vscode.postMessage({ command: 'updateAutoExtractFigure', value: isChecked });
  });
  document.getElementById('autoExtractTikzFigure').addEventListener('change', (event) => {
    const isChecked = event.target.checked;
    vscode.postMessage({ command: 'updateAutoExtractTikzFigure', value: isChecked });
  });
  document.getElementById('includeTikzReflection').addEventListener('change', (event) => {
    const isChecked = event.target.checked;
    vscode.postMessage({ command: 'updateIncludeTikzReflection', value: isChecked });
  });
  document.getElementById('includeTexCount').addEventListener('change', (event) => {
    const isChecked = event.target.checked;
    vscode.postMessage({ command: 'updateIncludeTexCount', value: isChecked });
  });
  document.getElementById('cleanOutputButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'cleanOutput'
    });
  });
  document.getElementById('cleanBuildButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'cleanBuild'
    });
  });
  document.getElementById('indentTexButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'indentTex'
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
    });
  });
  document.getElementById('packSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    vscode.postMessage({
      command: 'packSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model
    });
  });
  document.getElementById('cleanSingleButton').addEventListener('click', function () {
    const inputFile = document.getElementById('inputFileSelect').value;
    const task = document.getElementById('taskSelect').value;
    const reflect = document.getElementById('reflectSelect').value;
    const model = document.getElementById('modelSelect').value;
    vscode.postMessage({
      command: 'cleanSingle',
      inputFile: inputFile,
      task: task,
      reflect: reflect,
      model: model
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
  document.getElementById('refreshCommitsButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'refreshCommits'
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
  document.getElementById('currentFileButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'getCurrentFile'
    });
  });
  document.getElementById('currentEditedFileButton').addEventListener('click', function () {
    vscode.postMessage({
      command: 'getCurrentEditedFile',
      inputFile: document.getElementById('inputFileSelect').value,
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
  document.getElementById('modelSelect').addEventListener('change', saveState);
  document.getElementById('taskSelect').addEventListener('change', saveState);
  document.getElementById('inputFileSelect').addEventListener('change', saveState);
  document.getElementById('sampleFileSelect').addEventListener('change', saveState);
  document.getElementById('auxFileSelect').addEventListener('change', saveState);
  document.getElementById('figureFileSelect').addEventListener('change', saveState);
  document.getElementById('editedFileSelect').addEventListener('change', saveState);
  document.getElementById('taskInput').addEventListener('input', saveState);
  document.getElementById('reflectSelect').addEventListener('change', saveState);
  document.getElementById('commitSelect').addEventListener('change', saveState);
  document.getElementById('autoExtractFigure').addEventListener('change', saveState);
  document.getElementById('autoExtractTikzFigure').addEventListener('change', saveState);
  document.getElementById('includeTikzReflection').addEventListener('change', saveState);
  document.getElementById('includeTexCount').addEventListener('change', saveState);
});

function saveState() {
  const state = {
    modelSelect: document.getElementById('modelSelect').value,
    taskSelect: document.getElementById('taskSelect').value,
    inputFileSelect: document.getElementById('inputFileSelect').value,
    sampleFileSelect: document.getElementById('sampleFileSelect').value,
    auxFileSelect: document.getElementById('auxFileSelect').value,
    figureFileSelect: document.getElementById('figureFileSelect').value,
    editedFileSelect: document.getElementById('editedFileSelect').value,
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
  };
  vscode.setState(state);
}

function restoreState() {
  const previousState = vscode.getState();
  if (previousState) {
    document.getElementById('modelSelect').value = previousState.modelSelect || '';
    document.getElementById('taskSelect').value = previousState.taskSelect || 'correct-tex';
    document.getElementById('inputFileSelect').value = previousState.inputFileSelect || '';
    document.getElementById('auxFileSelect').value = previousState.auxFileSelect || '';
    document.getElementById('figureFileSelect').value = previousState.figureFileSelect || '';
    document.getElementById('sampleFileSelect').value = previousState.sampleFileSelect || '';
    document.getElementById('editedFileSelect').value = previousState.editedFileSelect || '';
    document.getElementById('taskInput').value = previousState.taskInput || '';
    document.getElementById('reflectSelect').value = previousState.reflectSelect || 'True';
    document.getElementById('commitSelect').value = previousState.commitSelect || 'HEAD';
    document.getElementById('autoExtractFigure').checked = previousState.autoExtractFigure || false;
    document.getElementById('autoExtractTikzFigure').checked = previousState.autoExtractTikzFigure || false;
    document.getElementById('includeTikzReflection').checked = previousState.includeTikzReflection || false;
    document.getElementById('includeTexCount').checked = previousState.includeTexCount || false;

    // Restore selected multiple files
    const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
    multipleInputFilesSelectDiv.innerHTML = '';
    if (previousState.multipleInputFilesSelect && previousState.multipleInputFilesSelect.length > 0) {
      previousState.multipleInputFilesSelect.forEach(file => {
        addFileToList('multipleInputFilesSelect', file);
      });
      multipleInputFilesSelectDiv.style.display = 'block';
    } else {
      multipleInputFilesSelectDiv.style.display = 'none';
    }

    // Restore selected multiple sample files
    const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
    multipleSampleFilesSelectDiv.innerHTML = '';
    if (previousState.multipleSampleFilesSelect && previousState.multipleSampleFilesSelect.length > 0) {
      previousState.multipleSampleFilesSelect.forEach(file => {
        addFileToList('multipleSampleFilesSelect', file);
      });
      multipleSampleFilesSelectDiv.style.display = 'block';
    } else {
      multipleSampleFilesSelectDiv.style.display = 'none';
    }

    // Restore selected multiple auxiliary files
    const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
    multipleAuxFilesSelectDiv.innerHTML = '';
    if (previousState.multipleAuxFilesSelect && previousState.multipleAuxFilesSelect.length > 0) {
      previousState.multipleAuxFilesSelect.forEach(file => {
        addFileToList('multipleAuxFilesSelect', file);
      });
      multipleAuxFilesSelectDiv.style.display = 'block';
    } else {
      multipleAuxFilesSelectDiv.style.display = 'none';
    }

    // Restore selected multiple figures
    const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
    multipleFiguresSelectDiv.innerHTML = '';
    if (previousState.multipleFiguresSelect && previousState.multipleFiguresSelect.length > 0) {
      previousState.multipleFiguresSelect.forEach(file => {
        addFileToList('multipleFiguresSelect', file);
      });
      multipleFiguresSelectDiv.style.display = 'block';
    } else {
      multipleFiguresSelectDiv.style.display = 'none';
    }
  }
}

window.addEventListener('message', event => {
  const message = event.data;
  switch (message.command) {
    case 'setMultipleFiles':
      const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
      const existingFiles = getSelectedFiles(multipleInputFilesSelectDiv);
      const newFiles = message.files.filter(file => !existingFiles.includes(file));
      if (newFiles.length > 0) {
        newFiles.forEach(file => {
          addFileToList('multipleInputFilesSelect', file);
        });
        multipleInputFilesSelectDiv.style.display = 'block';
      }
      saveState();
      break;
    case 'setMultipleSampleFiles':
      const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
      const existingSampleFiles = getSelectedFiles(multipleSampleFilesSelectDiv);
      const newSampleFiles = message.files.filter(file => !existingSampleFiles.includes(file));
      if (newSampleFiles.length > 0) {
        newSampleFiles.forEach(file => {
          addFileToList('multipleSampleFilesSelect', file);
        });
        multipleSampleFilesSelectDiv.style.display = 'block';
      }
      saveState();
      break;
    case 'setMultipleAuxFiles':
      const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
      const existingAuxFiles = getSelectedFiles(multipleAuxFilesSelectDiv);
      const newAuxFiles = message.files.filter(file => !existingAuxFiles.includes(file));
      if (newAuxFiles.length > 0) {
        newAuxFiles.forEach(file => {
          addFileToList('multipleAuxFilesSelect', file);
        });
        multipleAuxFilesSelectDiv.style.display = 'block';
      }
      saveState();
      break;
    case 'setMultipleFigures':
      const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
      const existingFigures = getSelectedFiles(multipleFiguresSelectDiv);
      const newFigures = message.files.filter(file => !existingFigures.includes(file));
      if (newFigures.length > 0) {
        newFigures.forEach(file => {
          addFileToList('multipleFiguresSelect', file);
        });
        multipleFiguresSelectDiv.style.display = 'block';
      }
      saveState();
      break;
    case 'setInputFile':
      const inputFileSelect = document.getElementById('inputFileSelect');
      inputFileSelect.innerHTML = '';
      const emptyInputOption = document.createElement('option');
      emptyInputOption.value = '';
      emptyInputOption.textContent = 'None';
      inputFileSelect.appendChild(emptyInputOption);
      message.files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        inputFileSelect.appendChild(option);
      });
      break;
    case 'setSampleFile':
      const sampleFileSelect = document.getElementById('sampleFileSelect');
      sampleFileSelect.innerHTML = '';
      const emptySampleOption = document.createElement('option');
      emptySampleOption.value = '';
      emptySampleOption.textContent = 'None';
      sampleFileSelect.appendChild(emptySampleOption);
      message.files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        sampleFileSelect.appendChild(option);
      });
      break;
    case 'setAuxFile':
      const auxFileSelect = document.getElementById('auxFileSelect');
      auxFileSelect.innerHTML = '';
      const emptyOption = document.createElement('option');
      emptyOption.value = '';
      emptyOption.textContent = 'None';
      auxFileSelect.appendChild(emptyOption);
      message.files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        auxFileSelect.appendChild(option);
      });
      break;
    case 'setFigureFile':
      const figureFileSelect = document.getElementById('figureFileSelect');
      figureFileSelect.innerHTML = '';
      const emptyFigureOption = document.createElement('option');
      emptyFigureOption.value = '';
      emptyFigureOption.textContent = 'None';
      figureFileSelect.appendChild(emptyFigureOption);
      message.files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        figureFileSelect.appendChild(option);
      });
      break;
    case 'setEditedFiles':
      const editedFileSelect = document.getElementById('editedFileSelect');
      editedFileSelect.innerHTML = '';
      const emptyEditedFile = document.createElement('option');
      emptyEditedFile.value = '';
      emptyEditedFile.textContent = 'None';
      editedFileSelect.appendChild(emptyEditedFile);
      message.files.forEach(file => {
        const option = document.createElement('option');
        option.value = file;
        option.textContent = file;
        editedFileSelect.appendChild(option);
      });
      break;
    case 'inputFileSelected':
      document.getElementById('inputFileSelect').value = message.filePath;
      vscode.postMessage({
        command: 'requestEditedFile',
        inputFile: message.filePath
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
      const commitSelect = document.getElementById('commitSelect');
      commitSelect.innerHTML = '';
      const emptyCommitOption = document.createElement('option');
      emptyCommitOption.value = 'HEAD';
      emptyCommitOption.textContent = 'HEAD';
      commitSelect.appendChild(emptyCommitOption);
      message.commits.forEach(commit => {
        const option = document.createElement('option');
        const [commitHash, ...commitMessage] = commit.split(': ');
        option.value = commitHash;
        option.textContent = commit;
        commitSelect.appendChild(option);
      });
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
    case 'getTheme':
      const theme = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light';
      vscode.postMessage({ command: 'setTheme', theme });
      break;
  }
  // Restore previous state
  restoreState();
});

// Request the theme when the page loads
window.addEventListener('load', requestTheme);

// Add this event listener to apply the theme
window.addEventListener('message', event => {
  const message = event.data;
  if (message.command === 'setTheme') {
    document.body.className = message.theme;
  }
});

// Add this function to request the current theme
function requestTheme() {
  vscode.postMessage({ command: 'getTheme' });
}