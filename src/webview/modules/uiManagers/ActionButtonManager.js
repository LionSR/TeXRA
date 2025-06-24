// Local imports - components
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHECK_BOXES } from '../constants.js';
import { fileList } from './FileList.js';

export class ActionButtonManager {
  constructor(vscodeApi = vscode, fileInputManager, list = fileList) {
    this.vscode = vscodeApi;
    this.fileInputManager = fileInputManager;
    this.fileList = list;
  }

  getCheckboxValues() {
    const values = {};
    CHECK_BOXES.forEach((id) => {
      values[id] = safeGetElementChecked(id);
    });
    return values;
  }

  setupExecuteButton() {
    addEventListenerSafely('executeButton', 'click', () => {
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue('instruction');

      const singleFiles = this.fileInputManager.getSingleFileData();
      const multipleFilesData =
        this.fileInputManager.getMultipleFileData(singleFiles);
      const checkboxValues = this.getCheckboxValues();

      this.vscode.postMessage({
        command: 'execute',
        agent,
        model,
        instruction,
        ...singleFiles,
        ...multipleFilesData,
        ...checkboxValues,
      });
    });
  }

  setupMergeButton() {
    addEventListenerSafely('mergeButton', 'click', () => {
      const { inputFile } = this.fileInputManager.getSingleFileData(['input']);
      const editedFile = safeGetElementValue('editedFile');

      this.vscode.postMessage({ command: 'merge', inputFile, editedFile });
      this.vscode.postMessage({
        command: 'showInformationMessage',
        text: `Merging files: ${inputFile} and ${editedFile}`,
      });
    });
  }

  setupPackCleanButtons() {
    ['pack', 'clean'].forEach((action) => {
      addEventListenerSafely(`${action}Button`, 'click', () => {
        const { inputFile } = this.fileInputManager.getSingleFileData([
          'input',
        ]);
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');

        const outputFiles = this.fileList.getSelected(
          safeGetElementById('outputFiles'),
        );
        const outputFilesContainer = safeGetElementById('outputFilesContainer');
        const useMultiple =
          outputFilesContainer &&
          outputFilesContainer.style.display === 'block' &&
          outputFiles.length > 0;

        if (useMultiple) {
          this.vscode.postMessage({
            command: `${action}Multiple`,
            inputFile,
            agent,
            model,
            outputFiles,
          });
          this.vscode.postMessage({
            command: 'showInformationMessage',
            text: `${capitalize(action)}ing multiple files: ${[inputFile, ...outputFiles].join(', ')}`,
          });
        } else {
          if (!inputFile || !agent || !model) {
            this.vscode.postMessage({
              command: 'showInformationMessage',
              text: 'Please select all required fields (input file, agent, and model)',
            });
            return;
          }
          this.vscode.postMessage({
            command: `${action}Single`,
            inputFile,
            agent,
            model,
          });
          this.vscode.postMessage({
            command: 'showInformationMessage',
            text: `${capitalize(action)}ing single file: ${inputFile}`,
          });
        }
      });
    });
  }

  setupLatexdiffButtons() {
    addEventListenerSafely('latexdiffButton', 'click', () => {
      const { inputFile } = this.fileInputManager.getSingleFileData(['input']);
      const baseFile = safeGetElementValue('baseFile');
      const editedFile = safeGetElementValue('editedFile');

      this.vscode.postMessage({
        command: 'latexdiff',
        inputFile,
        baseFile,
        editedFile,
      });
      this.vscode.postMessage({
        command: 'showInformationMessage',
        text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
      });
    });

    addEventListenerSafely('latexdiffvcButton', 'click', () => {
      const { inputFile } = this.fileInputManager.getSingleFileData(['input']);
      const baseFile = safeGetElementValue('baseFile');
      const commitHash = safeGetElementValue('commit');

      this.vscode.postMessage({
        command: 'latexdiffvc',
        inputFile,
        baseFile,
        commitHash,
      });
      this.vscode.postMessage({
        command: 'showInformationMessage',
        text: `Running LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });

    ['pack', 'clean'].forEach((action) => {
      addEventListenerSafely(`${action}LatexdiffvcButton`, 'click', () => {
        const { inputFile } = this.fileInputManager.getSingleFileData([
          'input',
        ]);
        const baseFile = safeGetElementValue('baseFile');
        const commitHash = safeGetElementValue('commit');

        this.vscode.postMessage({
          command: `${action}Latexdiffvc`,
          inputFile,
          baseFile,
          commitHash,
          clean: action === 'clean',
        });
        this.vscode.postMessage({
          command: 'showInformationMessage',
          text: `${capitalize(action)}ing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
        });
      });
    });
  }

  setupCompareAcceptButtons() {
    addEventListenerSafely('compareButton', 'click', () => {
      const baseFile = safeGetElementValue('baseFile');
      const editedFile = safeGetElementValue('editedFile');
      if (baseFile && editedFile) {
        this.vscode.postMessage({ command: 'compare', baseFile, editedFile });
      } else {
        this.vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Please select both base and edited files to compare',
        });
      }
    });

    addEventListenerSafely('acceptButton', 'click', () => {
      const baseFile = safeGetElementValue('baseFile');
      const editedFile = safeGetElementValue('editedFile');
      if (baseFile && editedFile) {
        this.vscode.postMessage({
          command: 'acceptEdited',
          baseFile,
          editedFile,
        });
      } else {
        this.vscode.postMessage({
          command: 'showInformationMessage',
          text: 'Please select both base and edited files to accept changes',
        });
      }
    });
  }

  setup() {
    this.setupExecuteButton();
    this.setupMergeButton();
    this.setupPackCleanButtons();
    this.setupLatexdiffButtons();
    this.setupCompareAcceptButtons();
  }
}
