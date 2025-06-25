import { vscode as globalVscode } from '@common/webviewContext.js';
import {
  addEventListenerSafely,
  safeGetElementValue,
  safeGetElementChecked,
  safeGetElementById,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHECK_BOXES, MULTIPLE_SELECTIONS } from '../constants.js';
import { fileList } from './FileList.js';

export class ActionButtonManager {
  constructor(vscode = globalVscode, instructionManager, state) {
    this.vscode = vscode;
    this.instructionManager = instructionManager;
    this.state = state;
  }

  getSingleFileData(fileTypes = ['input', 'reference', 'auxiliary', 'media']) {
    const data = {};
    fileTypes.forEach((type) => {
      const el = safeGetElementValue(`${type}File`);
      data[`${type}File`] = el;
    });
    return data;
  }

  getMultipleFileData(singleFiles = {}) {
    const multipleFilesData = {};
    MULTIPLE_SELECTIONS.forEach((id) => {
      const container = safeGetElementById(`${id}Container`);
      const isActive = container?.style.display === 'block';
      multipleFilesData[`${id}Active`] = isActive;

      const singleFileKey = id.replace('Files', 'File');
      const singleFile = singleFiles[singleFileKey];

      const filesDiv = safeGetElementById(id);
      const files = isActive && filesDiv ? fileList.getSelected(filesDiv) : [];
      multipleFilesData[id] =
        id !== 'outputFiles' && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });
    return multipleFilesData;
  }

  setup() {
    this.setupEraseInstruction();
    this.setupMagicPolish();
    this.setupExecute();
    this.setupCompare();
    this.setupAccept();
    this.setupMerge();
    this.setupPackClean();
    this.setupLatexdiff();
    this.setupLatexdiffvc();
    this.setupLatexdiffvcPackClean();
  }

  setupEraseInstruction() {
    addEventListenerSafely('eraseInstructionButton', 'click', () => {
      const instruction = safeGetElementById('instruction');
      if (instruction) {
        instruction.value = '';
        this.instructionManager?.autoResizeTextarea(instruction);
        this.state?.save();
      }
    });
  }

  setupMagicPolish() {
    addEventListenerSafely('magicPolishButton', 'click', () => {
      const instruction = safeGetElementValue('instruction');
      if (instruction.trim()) {
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const singleFiles = this.getSingleFileData();
        const multipleFilesData = this.getMultipleFileData(singleFiles);

        this.vscode.postMessage({
          command: 'polishInstructionText',
          text: instruction,
          agent,
          model,
          ...singleFiles,
          ...multipleFilesData,
        });
      }
    });
  }

  setupExecute() {
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
  }

  setupMerge() {
    addEventListenerSafely('mergeButton', 'click', () => {
      const { inputFile } = this.getSingleFileData(['input']);
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
  }

  setupCompare() {
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
  }

  setupAccept() {
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

  setupPackClean() {
    ['pack', 'clean'].forEach((action) => {
      addEventListenerSafely(`${action}Button`, 'click', () => {
        const { inputFile } = this.getSingleFileData(['input']);
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const outputFiles = fileList.getSelected(
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
            text: `${capitalize(action)}ing multiple files: ${[
              inputFile,
              ...outputFiles,
            ].join(', ')}`,
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

  setupLatexdiff() {
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
  }

  setupLatexdiffvc() {
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
  }

  setupLatexdiffvcPackClean() {
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
}
