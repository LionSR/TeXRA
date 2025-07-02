// Local imports
import { vscode } from '@common/webviewContext.js';
import {
  safeGetElementById,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHECK_BOXES, MULTIPLE_SELECTIONS, ELEMENT_IDS } from '../constants.js';

export class ActionButtonManager {
  constructor(vscodeInstance = vscode, fileList, state, instructionMgr) {
    this.vscode = vscodeInstance;
    this.fileList = fileList;
    this.state = state;
    this.instructionManager = instructionMgr;
    this._listeners = [];
  }

  _addListener(elementOrId, event, handler) {
    const element =
      typeof elementOrId === 'string'
        ? safeGetElementById(elementOrId)
        : elementOrId;
    if (element) {
      element.addEventListener(event, handler);
      this._listeners.push({ element, event, handler });
    }
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
        id !== ELEMENT_IDS.OUTPUT_FILES && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });
    return multipleFilesData;
  }

  _setupInstructionButtons() {
    this._addListener(ELEMENT_IDS.ERASE_INSTRUCTION_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction) {
        instruction.value = '';
        this.instructionManager.autoResizeTextarea(instruction);
        this.state.save();
      }
    });

    this._addListener(ELEMENT_IDS.MAGIC_POLISH_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
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
    this._addListener(ELEMENT_IDS.EXECUTE_BUTTON, 'click', () => {
      const agent = safeGetElementValue('agent');
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue(ELEMENT_IDS.INSTRUCTION);
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

    this._addListener(ELEMENT_IDS.MERGE_BUTTON, 'click', () => {
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

    [
      { id: ELEMENT_IDS.PACK_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this._addListener(id, 'click', () => {
        const { inputFile } = this._getSingleFileData(['input']);
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');

        const outputFiles = this.fileList.getSelected(
          safeGetElementById(ELEMENT_IDS.OUTPUT_FILES),
        );
        const container = safeGetElementById(
          ELEMENT_IDS.OUTPUT_FILES_CONTAINER,
        );
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
    this._addListener(ELEMENT_IDS.LATEXDIFF_BUTTON, 'click', () => {
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

    this._addListener(ELEMENT_IDS.LATEXDIFF_VC_BUTTON, 'click', () => {
      const { inputFile } = this._getSingleFileData(['input']);
      const baseFile = safeGetElementValue('baseFile');
      const commitHash = safeGetElementValue(ELEMENT_IDS.COMMIT_SELECT);

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

    [
      { id: ELEMENT_IDS.PACK_LATEXDIFF_VC_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_LATEXDIFF_VC_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this._addListener(id, 'click', () => {
        const { inputFile } = this._getSingleFileData(['input']);
        const baseFile = safeGetElementValue('baseFile');
        const commitHash = safeGetElementValue(ELEMENT_IDS.COMMIT_SELECT);

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
    this._addListener(ELEMENT_IDS.COMPARE_BUTTON, 'click', () => {
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

    this._addListener(ELEMENT_IDS.ACCEPT_BUTTON, 'click', () => {
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

  cleanup() {
    this._listeners.forEach(({ element, event, handler }) => {
      element.removeEventListener(event, handler);
    });
    this._listeners = [];
  }
}
