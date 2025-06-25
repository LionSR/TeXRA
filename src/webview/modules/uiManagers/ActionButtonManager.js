// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementById,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHECK_BOXES, MULTIPLE_SELECTIONS } from '../constants.js';

export class ActionButtonManager {
  constructor(vscodeInstance = vscode, fileList, state, instructionMgr) {
    this.vscode = vscodeInstance;
    this.fileList = fileList;
    this.state = state;
    this.instructionManager = instructionMgr;
  }

  _getSingleFileData(fileTypes = ['input', 'reference', 'auxiliary', 'media']) {
    const data = {};
    fileTypes.forEach((type) => {
      data[`${type}File`] = safeGetElementValue(`${type}File`);
    });
    return data;
  }

  _getMultipleFileData(singleFiles = {}) {
    const multipleFilesData = {};
    MULTIPLE_SELECTIONS.forEach((id) => {
      const container = safeGetElementById(`${id}Container`);
      const isActive = container?.style.display !== 'none';
      multipleFilesData[`${id}Active`] = isActive;

      const singleFileKey = id.replace('Files', 'File');
      const singleFile = singleFiles[singleFileKey];

      const filesDiv = safeGetElementById(id);
      const files =
        isActive && filesDiv ? this.fileList.getSelected(filesDiv) : [];

      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });
    return multipleFilesData;
  }

  _setupInstructionButtons() {
    addEventListenerSafely('eraseInstructionButton', 'click', () => {
      const instruction = safeGetElementById('instruction');
      if (instruction) {
        instruction.value = '';
        this.instructionManager.autoResizeTextarea(instruction);
        this.state.save();
      }
    });

    addEventListenerSafely('magicPolishButton', 'click', () => {
      const instruction = safeGetElementById('instruction');
      if (instruction && instruction.value.trim()) {
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const singleFiles = this._getSingleFileData();
        const multipleFilesData = this._getMultipleFileData(singleFiles);

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

  _setupExecuteButtons() {
    addEventListenerSafely('executeButton', 'click', () => {
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue('instruction');
      const singleFiles = this._getSingleFileData();
      const multipleFilesData = this._getMultipleFileData(singleFiles);

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
      const { inputFile } = this._getSingleFileData(['input']);
      const editedFile = safeGetElementValue('editedFile');

      this.vscode.postMessage({
        command: 'merge',
        inputFile,
        editedFile,
      });

      this.vscode.postMessage({
        command: 'showInformationMessage',
        text: `Merging files: ${inputFile} and ${editedFile}`,
      });
    });

    ['pack', 'clean'].forEach((action) => {
      addEventListenerSafely(`${action}Button`, 'click', () => {
        const { inputFile } = this._getSingleFileData(['input']);
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');

        const outputFiles = this.fileList.getSelected(
          safeGetElementById('outputFiles'),
        );
        const container = safeGetElementById('outputFilesContainer');
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

  _setupLatexdiffButtons() {
    addEventListenerSafely('latexdiffButton', 'click', () => {
      const { inputFile } = this._getSingleFileData(['input']);
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
      const { inputFile } = this._getSingleFileData(['input']);
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
        const { inputFile } = this._getSingleFileData(['input']);
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

  _setupCompareButtons() {
    addEventListenerSafely('compareButton', 'click', () => {
      const baseFile = safeGetElementValue('baseFile');
      const editedFile = safeGetElementValue('editedFile');
      if (baseFile && editedFile) {
        this.vscode.postMessage({
          command: 'compare',
          baseFile,
          editedFile,
        });
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
    this._setupInstructionButtons();
    this._setupExecuteButtons();
    this._setupLatexdiffButtons();
    this._setupCompareButtons();
  }
}
