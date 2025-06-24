import { vscode } from '@common/webviewContext.js';
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
    this.setupMagicPolish();
    this.setupExecute();
    this.setupMerge();
    this.setupPackClean();
    this.setupLatexdiff();
    this.setupLatexdiffvc();
    this.setupLatexdiffvcPackClean();
  }

  setupMagicPolish() {
    addEventListenerSafely('magicPolishButton', 'click', () => {
      const instruction = safeGetElementValue('instruction');
      if (instruction.trim()) {
        const agent = safeGetElementValue('agent');
        const model = safeGetElementValue('model');
        const singleFiles = this.getSingleFileData();
        const multipleFilesData = this.getMultipleFileData(singleFiles);

        vscode.postMessage({
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

      vscode.postMessage({
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

      vscode.postMessage({
        command: 'merge',
        inputFile,
        editedFile,
      });

      vscode.postMessage({
        command: 'showInformationMessage',
        text: `Merging files: ${inputFile} and ${editedFile}`,
      });
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
          vscode.postMessage({
            command: `${action}Multiple`,
            inputFile,
            agent,
            model,
            outputFiles,
          });
          vscode.postMessage({
            command: 'showInformationMessage',
            text: `${capitalize(action)}ing multiple files: ${[
              inputFile,
              ...outputFiles,
            ].join(', ')}`,
          });
        } else {
          if (!inputFile || !agent || !model) {
            vscode.postMessage({
              command: 'showInformationMessage',
              text: 'Please select all required fields (input file, agent, and model)',
            });
            return;
          }
          vscode.postMessage({
            command: `${action}Single`,
            inputFile,
            agent,
            model,
          });
          vscode.postMessage({
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

      vscode.postMessage({
        command: 'latexdiff',
        inputFile,
        baseFile,
        editedFile,
      });

      vscode.postMessage({
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

      vscode.postMessage({
        command: 'latexdiffvc',
        inputFile,
        baseFile,
        commitHash,
      });

      vscode.postMessage({
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

        vscode.postMessage({
          command: `${action}Latexdiffvc`,
          inputFile,
          baseFile,
          commitHash,
          clean: action === 'clean',
        });

        vscode.postMessage({
          command: 'showInformationMessage',
          text: `${capitalize(action)}ing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
        });
      });
    });
  }
}
