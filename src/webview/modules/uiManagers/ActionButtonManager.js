// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHECK_BOXES } from '../constants.js';
import { fileList } from './FileList.js';

/**
 * Handles main action buttons like execute and merge.
 */
export class ActionButtonManager {
  constructor(vscodeApi = vscode) {
    this.vscode = vscodeApi;
  }

  /** Gather values from single file selectors */
  getSingleFileData(fileTypes = ['input', 'reference', 'auxiliary', 'media']) {
    const data = {};
    fileTypes.forEach((type) => {
      data[`${type}File`] = safeGetElementValue(`${type}File`);
    });
    return data;
  }

  /** Gather multi-file selections while filtering out duplicates */
  getMultipleFileData(singleFiles = {}) {
    const multipleFilesData = {};
    const ids = [
      'inputFiles',
      'referenceFiles',
      'auxiliaryFiles',
      'mediaFiles',
      'outputFiles',
    ];
    ids.forEach((id) => {
      const container = document.getElementById(`${id}Container`);
      const isActive = container?.style.display !== 'none';
      multipleFilesData[`${id}Active`] = isActive;

      const singleFileKey = id.replace('Files', 'File');
      const singleFile = singleFiles[singleFileKey];
      const filesDiv = document.getElementById(id);
      const files = isActive && filesDiv ? fileList.getSelected(filesDiv) : [];
      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((f) => f !== singleFile)
          : files;
    });
    return multipleFilesData;
  }

  /** Setup magic polish and erase instruction buttons */
  setupInstructionActions() {
    addEventListenerSafely('eraseInstructionButton', 'click', () => {
      const instruction = document.getElementById('instruction');
      if (instruction) {
        instruction.value = '';
        instruction.dispatchEvent(new Event('input'));
      }
    });

    addEventListenerSafely('magicPolishButton', 'click', () => {
      const instruction = document.getElementById('instruction');
      if (instruction && instruction.value.trim()) {
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const singleFiles = this.getSingleFileData();
        const multipleFilesData = this.getMultipleFileData(singleFiles);
        this.vscode.postMessage({
          command: 'polishInstructionText',
          text: instruction.value,
          agent,
          model,
          ...singleFiles,
          ...multipleFilesData,
        });
      }
    });
  }

  /** Setup execute, merge and clean/pack buttons */
  setupExecuteButtons() {
    addEventListenerSafely('executeButton', 'click', () => {
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue('instruction');
      const singleFiles = this.getSingleFileData();
      const multipleFilesData = this.getMultipleFileData(singleFiles);
      const checkboxValues = {};
      CHECK_BOXES.forEach((id) => {
        checkboxValues[id] = safeGetElementChecked(id);
      });
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

    addEventListenerSafely('mergeButton', 'click', () => {
      const { inputFile } = this.getSingleFileData(['input']);
      const editedFile = safeGetElementValue('editedFile');
      this.vscode.postMessage({ command: 'merge', inputFile, editedFile });
      this.vscode.postMessage({
        command: 'showInformationMessage',
        text: `Merging files: ${inputFile} and ${editedFile}`,
      });
    });

    ['pack', 'clean'].forEach((action) => {
      addEventListenerSafely(`${action}Button`, 'click', () => {
        const { inputFile } = this.getSingleFileData(['input']);
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const outputFiles = fileList.getSelected(
          document.getElementById('outputFiles'),
        );
        const container = document.getElementById('outputFilesContainer');
        const useMultiple =
          container &&
          container.style.display !== 'none' &&
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

  /** Setup LaTeX diff related buttons */
  setupLatexDiffButtons() {
    addEventListenerSafely('latexdiffButton', 'click', () => {
      const { inputFile } = this.getSingleFileData(['input']);
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
      const { inputFile } = this.getSingleFileData(['input']);
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
        const { inputFile } = this.getSingleFileData(['input']);
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

  /** Setup compare and accept buttons */
  setupDiffButtons() {
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

  /** Set up all handlers */
  setup() {
    this.setupInstructionActions();
    this.setupExecuteButtons();
    this.setupLatexDiffButtons();
    this.setupDiffButtons();
  }
}

export const actionButtonManager = new ActionButtonManager();
