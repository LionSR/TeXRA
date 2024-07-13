import * as vscode from 'vscode';
import * as path from 'path';
import { listInputFiles, listSampleFiles, listAuxFiles, listFigureFiles, listRevisionFiles } from './utils';

export class CoAuthorViewProvider implements vscode.WebviewViewProvider {
  constructor(private readonly context: vscode.ExtensionContext) { }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    webviewView.webview.options = {
      enableScripts: true
    };

    webviewView.webview.html = this.getWebviewContent();

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message.command) {
        case 'cleanOutput':
          vscode.commands.executeCommand('coauthor.cleanOutput');
          break;
        case 'cleanBuild':
          vscode.commands.executeCommand('coauthor.cleanBuild');
          break;
        case 'indentTex':
          vscode.commands.executeCommand('coauthor.indentTex');
          break;
        case 'execute':
          const task_val = message.task;
          const model_val = message.model;
          const reflect_val = message.reflect;
          const inputFile_val = message.inputFile;
          const additionalInputFiles_val = message.additionalInputFiles;
          const sampleFiles_val = message.sampleFiles;
          const auxFiles_val = message.auxFiles;
          const figureFiles_val = message.figureFiles;

          const instructions_val = message.instructions;

          const autoExtractFigure_val = message.autoExtractFigure;
          const autoExtractTikzFigure_val = message.autoExtractTikzFigure;
          const includeTikzReflection_val = message.includeTikzReflection;
          const includeTexCount_val = message.includeTexCount;

          vscode.commands.executeCommand('coauthor.execute', task_val, inputFile_val, auxFiles_val, instructions_val, reflect_val, model_val, figureFiles_val, additionalInputFiles_val, sampleFiles_val, autoExtractFigure_val, autoExtractTikzFigure_val, includeTikzReflection_val, includeTexCount_val);
          break;
        case 'selectInputFile':
          const inputFile = await vscode.commands.executeCommand<string>('coauthor.selectInputFile');
          if (inputFile) {
            webviewView.webview.postMessage({ command: 'inputFileSelected', filePath: inputFile });
          }
          break;
        case 'selectSampleFile':
          const sampleFile = await vscode.commands.executeCommand<string>('coauthor.selectSampleFile');
          if (sampleFile) {
            webviewView.webview.postMessage({ command: 'sampleFileSelected', filePath: sampleFile });
          }
          break;
        case 'selectAuxFile':
          const auxFile = await vscode.commands.executeCommand<string>('coauthor.selectAuxFile');
          if (auxFile) {
            webviewView.webview.postMessage({ command: 'auxFileSelected', filePath: auxFile });
          }
          break;
        case 'selectFigureFile':
          const figureFile = await vscode.commands.executeCommand<string>('coauthor.selectFigureFile');
          if (figureFile) {
            webviewView.webview.postMessage({ command: 'figureFileSelected', filePath: figureFile });
          }
          break;
        case 'selectMultipleFiles':
          const multipleInputFilesSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleFiles', message.currentInputFile);
          if (multipleInputFilesSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleFiles', files: multipleInputFilesSelect });
          }
          break;
        case 'selectMultipleSampleFiles':
          const multipleSampleFilesSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleSampleFiles', message.currentSampleFile);
          if (multipleSampleFilesSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleSampleFiles', files: multipleSampleFilesSelect });
          }
          break;
        case 'selectMultipleAuxFiles':
          const multipleAuxFilesSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleAuxFiles');
          if (multipleAuxFilesSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleAuxFiles', files: multipleAuxFilesSelect });
          }
          break;
        case 'selectMultipleFigures':
          const multipleFiguresSelect = await vscode.commands.executeCommand<string[]>('coauthor.selectMultipleFigures', message.currentFigureFile);
          if (multipleFiguresSelect) {
            webviewView.webview.postMessage({ command: 'setMultipleFigures', files: multipleFiguresSelect });
          }
          break;
        case 'selectRevisionFile':
          const revisionFile = await vscode.commands.executeCommand<string>('coauthor.selectRevisionFile');
          if (revisionFile) {
            webviewView.webview.postMessage({ command: 'revisionFileSelected', filePath: revisionFile });
          }
          break;
        case 'requestInputFile':
          const inputFiles = await listInputFiles();
          webviewView.webview.postMessage({ command: 'setInputFile', files: inputFiles });
          break;
        case 'requestSampleFile':
          const sampleFiles = await listSampleFiles();
          webviewView.webview.postMessage({ command: 'setSampleFile', files: sampleFiles });
          break;
        case 'requestAuxFile':
          const auxFiles = await listAuxFiles();
          webviewView.webview.postMessage({ command: 'setAuxFile', files: auxFiles });
          break;
        case 'requestFigureFile':
          const figureFiles = await listFigureFiles();
          webviewView.webview.postMessage({ command: 'setFigureFile', files: figureFiles });
          break;

        case 'requestRevisionFile':
          const allRevisionFiles = await listRevisionFiles(message.inputFile);
          webviewView.webview.postMessage({ command: 'setRevisionFiles', files: allRevisionFiles });
          break;
        case 'inputFileSelected':
          vscode.window.showInformationMessage(`Selected file: ${message.filePath}`);
          const filteredRevisionFiles = await listRevisionFiles(message.filePath);
          webviewView.webview.postMessage({ command: 'setRevisionFiles', files: filteredRevisionFiles });
          break;
        case 'sampleFileSelected':
          vscode.window.showInformationMessage(`Selected sample file: ${message.filePath}`);
          break;
        case 'auxFileSelected':
          vscode.window.showInformationMessage(`Selected auxiliary file: ${message.filePath}`);
          break;
        case 'figureFileSelected':
          vscode.window.showInformationMessage(`Selected figure file: ${message.filePath}`);
          break;
        case 'revisionFileSelected':
          vscode.window.showInformationMessage(`Selected revision file: ${message.filePath}`);
          break;
        case 'modelSelect':
          vscode.window.showInformationMessage(`Selected model: ${message.model}`);
          if (message.model) {
            webviewView.webview.postMessage({
              command: 'modelSelected',
              model: message.model
            });
          }
          break;
        case 'cleanSingle':
          vscode.commands.executeCommand('coauthor.cleanSingle', message.inputFile, message.task, message.reflect, message.model);
          break;
        case 'packSingle':
          vscode.commands.executeCommand('coauthor.packSingle', message.inputFile, message.task, message.reflect, message.model);
          break;
        case 'latexDiff':
          vscode.commands.executeCommand('coauthor.latexDiff', message.inputFile, message.revisionFile);
          break;
        case 'latexDiffVC':
          vscode.commands.executeCommand('coauthor.latexDiffVC', message.inputFile, message.commitHash);
          break;
        case 'requestRecentCommits':
          const commits = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
          webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits });
          break;
        case 'refreshCommits':
          const commits_refresh = await vscode.commands.executeCommand<string[]>('coauthor.getRecentCommits');
          webviewView.webview.postMessage({ command: 'setRecentCommits', commits: commits_refresh });
          break;
        case 'packLatexDiffVC':
          vscode.commands.executeCommand('coauthor.packLatexDiffVC', message.inputFile, message.commitHash, message.clean);
          break;
        case 'getCurrentFile':
          const currentFile = await vscode.commands.executeCommand<string>('coauthor.getCurrentFile');
          if (currentFile) {
            webviewView.webview.postMessage({ command: 'setCurrentFile', filePath: currentFile });
          } else {
            vscode.window.showInformationMessage('No file is currently open or the file is not part of the workspace.');
          }
          break;
        case 'getCurrentRevisionFile':
          if (message.inputFile) {
            const revisionFiles = await listRevisionFiles(message.inputFile);
            webviewView.webview.postMessage({ command: 'setRevisionFiles', files: revisionFiles });
          } else {
            vscode.window.showInformationMessage('Please select an input file first.');
          }
          break;
        case 'merge':
          vscode.commands.executeCommand('coauthor.merge', message.inputFile, message.revisionFile);
          break;
      }
    });
  }

  private getWebviewContent() {
    const config = vscode.workspace.getConfiguration('coauthor');
    const tasks = config.get<string[]>('tasks') || [];

    const taskOptions = tasks.map(task =>
      `<option value="${task}">${task}</option>`
    ).join('\n');

    return `<!DOCTYPE html>
    <html lang="en">
    <script src="https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.14.0/Sortable.min.js"></script>
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>CoAuthor Panel</title>
      <style>
      .compact-selections {
        display: flex;
        gap: 10px;
        margin-bottom: 15px;
      }
      
      .select-group {
        display: flex;
        flex-direction: column;
        flex: 1;
      }
      
      .select-group label {
        font-size: 12px;
        margin-bottom: 2px;
      }
      
      .select-group select {
        width: 100%;
        padding: 4px;
        height: 28px;
        border: 1px solid #ccc;
        border-radius: 3px;
        background-color: #fff;
      }
      
      .file-selection-group {
        background-color: #f5f5f5;
        border: 1px solid #ddd;
        border-radius: 4px;
        padding: 10px;
        margin-bottom: 15px;
      }
      
      .file-select {
        margin-bottom: 8px;
      }

      .file-select-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 5px;
      }
      
      .file-select-header label {
        font-size: 12px;
        font-weight: bold;
      }
      
      .file-select label {
        display: block;
        margin-bottom: 2px;
        font-size: 12px;
      }

      .file-select-buttons {
        display: flex;
        gap: 5px;
        margin-left: auto;
      }
            
      .small-button {
        padding: 2px 8px;
        font-size: 11px;
        background-color: #f0f0f0;
        border: 1px solid #ccc;
        border-radius: 3px;
        cursor: pointer;
      }

      .file-select select {
        width: 100%;
        padding: 4px;
        height: 28px;
        border: 1px solid #ccc;
        border-radius: 3px;
        background-color: #fff;
        font-size: 12px;
      }
      
      .multiple-files-list {
        margin-top: 5px;
        background-color: #fff;
        border: 1px solid #ddd;
        border-radius: 3px;
        padding: 5px;
        font-size: 12px;
        max-height: 100px;
        overflow-y: auto;
      }
      
      .multiple-files-list div {
        padding: 2px 4px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      
      .remove-button {
        color: #ff4444;
        cursor: pointer;
      }
      
      .instruction-box {
        margin-bottom: 5px;
      }
      
      .instruction-box label {
        display: block;
        margin-bottom: 2px;
        font-size: 12px;
      }
      
      #taskInput {
        width: 100%;
        min-height: 150px;  /* Increased initial height */
        max-height: 300px;  /* Maximum height before scrolling */
        padding: 8px;
        border: 1px solid #ccc;
        border-radius: 4px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-size: 13px;
        resize: vertical;  /* Allows vertical resizing */
        overflow-y: auto;  /* Adds vertical scrollbar when needed */
        background-color: #fff;
        box-sizing: border-box;
      }
      
      .checkbox-group {
        display: flex;
        gap: 1px;
        flex-direction: column;
      }
      
      .checkbox-group label {
        display: flex;
        align-items: center;
        font-size: 12px;
      }

      .checkbox-group input[type="checkbox"] {
        margin-right: 5px;
      }
      
      #executeButton {
        padding: 6px 12px;
        font-size: 14px;
        background-color: #007acc;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
      }

      #executeButton:hover {
        background-color: #005999;
      }

      .section {
        margin-bottom: 10px;
      }
      
      .section-header {
        font-size: 12px;
        font-weight: bold;
        margin-top: 10px;
        margin-bottom: 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid #ccc;
      }
      .button-group {
        margin-bottom: 10px;
      }
      .button-group label {
        display: block;
        font-size: 12px;
        margin-bottom: 5px;
      }
      .button-container {
        display: flex;
        gap: 5px;
      }

      .tool-use-execute {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-top: 5px;
        margin-bottom: tpx;
      }
      
      .tool-use {
        display: flex;
        flex-direction: column;
      }
      
      .tool-use label {
        font-size: 12px;
        margin-bottom: 2px;
      }
      
      .instruction-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 5px;
      }

      .instruction-header label {
        font-size: 12px;
        font-weight: bold;
      }

      </style>
      <script>
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

        window.onload = function() {
          vscode.postMessage({ command: 'requestInputFile' });
          vscode.postMessage({ command: 'requestSampleFile' });
          vscode.postMessage({ command: 'requestAuxFile' });
          vscode.postMessage({ command: 'requestFigureFile' });
          vscode.postMessage({ command: 'requestRevisionFile' });
          vscode.postMessage({ command: 'requestRecentCommits' });
          // Restore previous state
          restoreState();
        };
        document.addEventListener('DOMContentLoaded', function() {
          new Sortable(document.getElementById('multipleInputFilesSelect'), {
            animation: 150,
            onEnd: function() {
              saveState();
            }
          });
      
          // Initialize Sortable for multiple auxiliary files
          new Sortable(document.getElementById('multipleAuxFilesSelect'), {
            animation: 150,
            onEnd: function() {
              saveState();
            }
          });
      
          // Initialize Sortable for multiple figures
          new Sortable(document.getElementById('multipleFiguresSelect'), {
            animation: 150,
            onEnd: function() {
              saveState();
            }
          });
      
          // Initialize Sortable for multiple sample files
          new Sortable(document.getElementById('multipleSampleFilesSelect'), {
            animation: 150,
            onEnd: function() {
              saveState();
            }
          });
          document.getElementById('taskSelect').addEventListener('change', function() {
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
          document.getElementById('modelSelect').addEventListener('change', function() {
            vscode.postMessage({
              command: 'modelSelect',
              model: this.value
            });
          });
          document.getElementById('inputFileSelect').addEventListener('change', function() {
            const inputFile = this.value;
            vscode.postMessage({
              command: 'inputFileSelected',
              filePath: inputFile
            });
          });
          document.getElementById('sampleFileSelect').addEventListener('change', function() {
            const sampleFile = this.value;
            vscode.postMessage({
              command: 'sampleFileSelected',
              filePath: sampleFile
            });
          });
          document.getElementById('selectMultipleFilesButton').addEventListener('click', function() {
            const currentInputFile = document.getElementById('inputFileSelect').value;
            vscode.postMessage({
              command: 'selectMultipleFiles',
              currentInputFile: currentInputFile
            });
          });
          document.getElementById('selectMultipleSampleFilesButton').addEventListener('click', function() {
            const currentSampleFile = document.getElementById('sampleFileSelect').value;
            vscode.postMessage({
              command: 'selectMultipleSampleFiles',
              currentSampleFile: currentSampleFile
            });
          });
          document.getElementById('selectMultipleAuxFilesButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'selectMultipleAuxFiles'
            });
          });
          document.getElementById('selectMultipleFiguresButton').addEventListener('click', function() {
            const currentFigureFile = document.getElementById('figureFileSelect').value;
            vscode.postMessage({
              command: 'selectMultipleFigures',
              currentFigureFile: currentFigureFile
            });
          });
          document.getElementById('emptyMultipleFilesButton').addEventListener('click', function() {
            const multipleInputFilesSelectDiv = document.getElementById('multipleInputFilesSelect');
            multipleInputFilesSelectDiv.innerHTML = '';
            multipleInputFilesSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('emptyMultipleAuxFilesButton').addEventListener('click', function() {
            const multipleAuxFilesSelectDiv = document.getElementById('multipleAuxFilesSelect');
            multipleAuxFilesSelectDiv.innerHTML = '';
            multipleAuxFilesSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('emptyMultipleFiguresButton').addEventListener('click', function() {
            const multipleFiguresSelectDiv = document.getElementById('multipleFiguresSelect');
            multipleFiguresSelectDiv.innerHTML = '';
            multipleFiguresSelectDiv.style.display = 'none';
            
            // Set the single figure file select to "None"
            document.getElementById('figureFileSelect').value = '';
            saveState();
          });
          document.getElementById('emptyMultipleSampleFilesButton').addEventListener('click', function() {
            const multipleSampleFilesSelectDiv = document.getElementById('multipleSampleFilesSelect');
            multipleSampleFilesSelectDiv.innerHTML = '';
            multipleSampleFilesSelectDiv.style.display = 'none';
            saveState();
          });
          document.getElementById('emptyInstructionsButton').addEventListener('click', function() {
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
          document.getElementById('cleanOutputButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'cleanOutput'
            });
          });
          document.getElementById('cleanBuildButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'cleanBuild'
            });
          });
          document.getElementById('indentTexButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'indentTex'
            });
          });
          document.getElementById('executeButton').addEventListener('click', function() {
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
          document.getElementById('packSingleButton').addEventListener('click', function() {
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
          document.getElementById('cleanSingleButton').addEventListener('click', function() {
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
          document.getElementById('latexDiffButton').addEventListener('click', function() {
            const inputFile = document.getElementById('inputFileSelect').value;
            const revisionFile = document.getElementById('revisionFileSelect').value;
            vscode.postMessage({
              command: 'latexDiff',
              inputFile: inputFile,
              revisionFile: revisionFile
            });
          });
          document.getElementById('latexDiffVCButton').addEventListener('click', function() {
            const inputFile = document.getElementById('inputFileSelect').value;
            const commitHash = document.getElementById('commitSelect').value;
            vscode.postMessage({
              command: 'latexDiffVC',
              inputFile: inputFile,
              commitHash: commitHash
            });
          });
          document.getElementById('refreshCommitsButton').addEventListener('click', function() {
            vscode.postMessage({
                command: 'refreshCommits'
            });
          });
          document.getElementById('packLatexDiffVCButton').addEventListener('click', function() {
            const inputFile = document.getElementById('inputFileSelect').value;
            const commitHash = document.getElementById('commitSelect').value;
            vscode.postMessage({
              command: 'packLatexDiffVC',
              inputFile: inputFile,
              commitHash: commitHash,
              clean: false
            });
          });
          document.getElementById('cleanLatexDiffVCButton').addEventListener('click', function() {
            const inputFile = document.getElementById('inputFileSelect').value;
            const commitHash = document.getElementById('commitSelect').value;
            vscode.postMessage({
              command: 'packLatexDiffVC',
              inputFile: inputFile,
              commitHash: commitHash,
              clean: true
            });
          });
          document.getElementById('currentFileButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'getCurrentFile'
            });
          });
          document.getElementById('currentRevisionButton').addEventListener('click', function() {
            vscode.postMessage({
              command: 'getCurrentRevisionFile',
              inputFile: document.getElementById('inputFileSelect').value,
            });
          });
          document.getElementById('mergeButton').addEventListener('click', function() {
            const inputFile = document.getElementById('inputFileSelect').value;
            const revisionFile = document.getElementById('revisionFileSelect').value;
            vscode.postMessage({
              command: 'merge',
              inputFile: inputFile,
              revisionFile: revisionFile
            });
          });

          // Save state on input changes
          document.getElementById('modelSelect').addEventListener('change', saveState);
          document.getElementById('taskSelect').addEventListener('change', saveState);
          document.getElementById('inputFileSelect').addEventListener('change', saveState);
          document.getElementById('sampleFileSelect').addEventListener('change', saveState);
          document.getElementById('auxFileSelect').addEventListener('change', saveState);
          document.getElementById('figureFileSelect').addEventListener('change', saveState);
          document.getElementById('revisionFileSelect').addEventListener('change', saveState);
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
            revisionFileSelect: document.getElementById('revisionFileSelect').value,
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
            document.getElementById('revisionFileSelect').value = previousState.revisionFileSelect || '';
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
            case 'setRevisionFiles':
              const revisionFileSelect = document.getElementById('revisionFileSelect');
              revisionFileSelect.innerHTML = '';
              const emptyRevisionOption = document.createElement('option');
              emptyRevisionOption.value = '';
              emptyRevisionOption.textContent = 'None';
              revisionFileSelect.appendChild(emptyRevisionOption);
              message.files.forEach(file => {
                const option = document.createElement('option');
                option.value = file;
                option.textContent = file;
                revisionFileSelect.appendChild(option);
              });
              break;
            case 'inputFileSelected':
              document.getElementById('inputFileSelect').value = message.filePath;
              vscode.postMessage({
                command: 'requestRevisionFile',
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
            case 'revisionFileSelected':
              document.getElementById('revisionFileSelect').value = message.filePath;
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
          }
          // Restore previous state
          restoreState();
        });
      </script>
    </head>
    <body>
      <div class="compact-selections">
        <div class="select-group">
          <label for="taskSelect">Task:</label>
          <select id="taskSelect">
            ${taskOptions}
          </select>
        </div>
        <div class="select-group">
          <label for="modelSelect">Model:</label>
          <select id="modelSelect">
            <option value="sonnet+">Sonnet+</option>
            <option value="opus">Opus</option>
            <option value="sonnet">Sonnet</option>
            <option value="haiku">Haiku</option>
            <option value="gpt4o">GPT-4 Omni</option>
            <option value="gpt4t">GPT-4 Turbo</option>
          </select>
        </div>
        <div class="select-group">
          <label for="reflectSelect">Reflect:</label>
          <select id="reflectSelect">
            <option value="True">True</option>
            <option value="False">False</option>
          </select>
        </div>
      </div>
      </p>
      <div class="file-selection-group">
        <div class="file-select">
          <div class="file-select-header">
            <label for="inputFileSelect">Select Input File:</label>
            <div class="file-select-buttons">
              <button id="currentFileButton" class="small-button">Current</button>
              <button id="emptyMultipleFilesButton" class="small-button">Empty</button>
              <button id="selectMultipleFilesButton" class="small-button">Multiple</button>
            </div>
          </div>
          <select id="inputFileSelect">
            <option value="">None</option>
          </select>
          <div id="multipleInputFilesSelect" class="multiple-files-list" style="display: none;"></div>
        </div>
        <div class="file-select">
          <div class="file-select-header">
            <label for="sampleFileSelect">Select Reference File:</label>
            <div class="file-select-buttons">
              <button id="emptyMultipleSampleFilesButton" class="small-button">Empty</button>
              <button id="selectMultipleSampleFilesButton" class="small-button">Multiple</button>
            </div>
          </div>
          <select id="sampleFileSelect">
            <option value="">None</option>
          </select>
          <div id="multipleSampleFilesSelect" class="multiple-files-list" style="display: none;"></div>
        </div>
        <div class="file-select">
          <div class="file-select-header">
            <label for="auxFileSelect">Select Auxiliary File:</label>
            <div class="file-select-buttons">
              <button id="emptyMultipleAuxFilesButton" class="small-button">Empty</button>
              <button id="selectMultipleAuxFilesButton" class="small-button">Multiple</button>
            </div>
          </div>
          <select id="auxFileSelect">
            <option value="">None</option>
          </select>
          <div id="multipleAuxFilesSelect" class="multiple-files-list" style="display: none;"></div>
        </div>
        <div class="file-select">
          <div class="file-select-header">
            <label for="figureFileSelect">Select Figure:</label>
            <div class="file-select-buttons">
              <button id="emptyMultipleFiguresButton" class="small-button">Empty</button>
              <button id="selectMultipleFiguresButton" class="small-button">Multiple</button>
            </div>
          </div>
          <select id="figureFileSelect">
            <option value="">None</option>
          </select>
          <div id="multipleFiguresSelect" class="multiple-files-list" style="display: none;"></div>
        </div>
      </div>
      <p>
        <div class="instruction-box">
          <div class="instruction-header">
            <label for="taskInput">Specific Instructions:</label>
            <button id="emptyInstructionsButton" class="small-button">Empty</button>
          </div>
          <textarea id="taskInput" placeholder="Enter your instructions such as: Gently correct mathematical mistakes and typos."></textarea>
        </div>
        <div class="tool-use-execute">
        <div class="tool-use">
          <div class="checkbox-group">
            <label><input type="checkbox" id="autoExtractFigure"> Auto-extract Figs</label>
            <label><input type="checkbox" id="autoExtractTikzFigure"> Auto-extract TikZ Figs</label>
            <label><input type="checkbox" id="includeTikzReflection"> Include TikZ Reflection</label>
            <label><input type="checkbox" id="includeTexCount"> Include Tex Count</label>
          </div>
        </div>
        <button id="executeButton">Execute</button>
      </div>
      </p>
      <div class="section">
      <h5 class="section-header">Housekeeping</h5>
      <div class="button-group">
        <label>For the Selected Task and Files:</label>
        <div class="button-container">
          <button id="packSingleButton" class="small-button">Pack</button>
          <button id="cleanSingleButton" class="small-button">Clean</button>
        </div>
      </div>
      <div class="button-group">
        <label>For All the Files:</label>
        <div class="button-container">
          <button id="indentTexButton" class="small-button">Indent TeX</button>
          <button id="cleanOutputButton" class="small-button">Clean Output</button>
          <button id="cleanBuildButton" class="small-button">Clean Build</button>
        </div>
      </div>
    </div>
    
    <div class="section">
      <h5 class="section-header">Smart Diffs</h5>
      <div class="file-select">
        <div class="file-select-header">
          <label for="revisionFileSelect">Select Revision File:</label>
          <div class="file-select-buttons">
            <button id="currentRevisionButton" class="small-button">Current</button>
            <button id="mergeButton" class="small-button">Merge</button>
            <button id="latexDiffButton" class="small-button">latexdiff</button>
          </div>
        </div>
        <select id="revisionFileSelect">
          <option value="">None</option>
        </select>
      </div>
      <div class="file-select">
        <div class="file-select-header">
          <label for="commitSelect">Select Commit:</label>
          <div class="file-select-buttons">
            <button id="refreshCommitsButton" class="small-button">Refresh</button>
            <button id="packLatexDiffVCButton" class="small-button">Pack</button>
            <button id="cleanLatexDiffVCButton" class="small-button">Clean</button>
            <button id="latexDiffVCButton" class="small-button">latexdiff-vc</button>
          </div>
        </div>
        <select id="commitSelect">
          <option value="HEAD">HEAD</option>
        </select>
      </div>
    </div>
    </body>
    </html>`;
  }
}
