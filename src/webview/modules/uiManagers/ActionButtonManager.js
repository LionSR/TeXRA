// Local imports - webview
import {
  CHECK_BOXES,
  MULTIPLE_SELECTIONS,
  ELEMENT_IDS,
  BASE_FILE,
  EDITED_FILE,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
} from '../constants.js';
import { BaseUIManager } from './BaseUIManager.js';
import {
  safeGetElementById,
  safeGetElementValue,
  safeGetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class ActionButtonManager extends BaseUIManager {
  constructor(vscodeInstance = vscode, fileList, state, instructionMgr) {
    super();
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
        id !== ELEMENT_IDS.OUTPUT_FILES && singleFile
          ? files.filter((file) => file !== singleFile)
          : files;
    });
    return multipleFilesData;
  }

  _setupInstructionButtons() {
    this.addListener(ELEMENT_IDS.ERASE_INSTRUCTION_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction) {
        instruction.value = '';
        this.instructionManager.autoResizeTextarea(instruction);
        this.state.save();
      }
    });

    this.addListener(ELEMENT_IDS.MAGIC_POLISH_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction && instruction.value.trim()) {
        const { agent } = this._getActiveAgentSelection();
        const model = safeGetElementValue('model');
        const singleFiles = this._getSingleFileData();
        const multipleFilesData = this._getMultipleFileData(singleFiles);

        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT,
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
    this.addListener(ELEMENT_IDS.EXECUTE_BUTTON, 'click', () => {
      const { agent, sessionType } = this._getActiveAgentSelection();
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue(ELEMENT_IDS.INSTRUCTION);
      const isToolUseAgent = sessionType === SESSION_TYPES.TOOL_USE;
      const singleFiles = this._getSingleFileData();
      const multipleFilesData = this._getMultipleFileData(singleFiles);

      const checkboxValues = {};
      CHECK_BOXES.forEach((id) => {
        checkboxValues[id] = safeGetElementChecked(id);
      });

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        agent,
        model,
        instruction,
        isToolUseAgent,
        ...singleFiles,
        ...multipleFilesData,
        ...checkboxValues,
      });
    });

    this.addListener(ELEMENT_IDS.MERGE_BUTTON, 'click', () => {
      const { inputFile } = this._getSingleFileData(['input']);
      const editedFile = safeGetElementValue(EDITED_FILE);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.MERGE,
        inputFile,
        editedFile,
      });

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `Merging files: ${inputFile} and ${editedFile}`,
      });
    });

    [
      { id: ELEMENT_IDS.PACK_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this.addListener(id, 'click', () => {
        const { inputFile } = this._getSingleFileData(['input']);
        const { agent } = this._getActiveAgentSelection();
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
          const multipleCommand =
            action === 'pack'
              ? MAIN_VIEW_COMMANDS.PACK_MULTIPLE
              : MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE;
          this.vscode.postMessage({
            command: multipleCommand,
            inputFile,
            agent,
            model,
            outputFiles,
          });

          this.vscode.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
            text: `${capitalize(action)}ing multiple files: ${[inputFile, ...outputFiles].join(', ')}`,
          });
        } else {
          if (!inputFile || !agent || !model) {
            this.vscode.postMessage({
              command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
              text: 'Please select all required fields (input file, agent, and model)',
            });
            return;
          }

          const singleCommand =
            action === 'pack'
              ? MAIN_VIEW_COMMANDS.PACK_SINGLE
              : MAIN_VIEW_COMMANDS.CLEAN_SINGLE;
          this.vscode.postMessage({
            command: singleCommand,
            inputFile,
            agent,
            model,
          });

          this.vscode.postMessage({
            command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
            text: `${capitalize(action)}ing single file: ${inputFile}`,
          });
        }
      });
    });
  }

  _setupLatexdiffButtons() {
    this.addListener(ELEMENT_IDS.LATEXDIFF_BUTTON, 'click', () => {
      const { inputFile } = this._getSingleFileData(['input']);
      const baseFile = safeGetElementValue(BASE_FILE);
      const editedFile = safeGetElementValue(EDITED_FILE);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.LATEXDIFF,
        inputFile,
        baseFile,
        editedFile,
      });

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
      });
    });

    this.addListener(ELEMENT_IDS.LATEXDIFF_VC_BUTTON, 'click', () => {
      const { inputFile } = this._getSingleFileData(['input']);
      const baseFile = safeGetElementValue(BASE_FILE);
      const commitHash = safeGetElementValue(ELEMENT_IDS.COMMIT_SELECT);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.LATEXDIFFVC,
        inputFile,
        baseFile,
        commitHash,
      });

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `Running LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      });
    });

    [
      { id: ELEMENT_IDS.PACK_LATEXDIFF_VC_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_LATEXDIFF_VC_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this.addListener(id, 'click', () => {
        const { inputFile } = this._getSingleFileData(['input']);
        const baseFile = safeGetElementValue(BASE_FILE);
        const commitHash = safeGetElementValue(ELEMENT_IDS.COMMIT_SELECT);

        const command =
          action === 'pack'
            ? MAIN_VIEW_COMMANDS.PACK_LATEXDIFFVC
            : MAIN_VIEW_COMMANDS.CLEAN_LATEXDIFFVC;
        this.vscode.postMessage({
          command,
          inputFile,
          baseFile,
          commitHash,
          clean: action === 'clean',
        });

        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
          text: `${capitalize(action)}ing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
        });
      });
    });
  }

  _setupCompareButtons() {
    this.addListener(ELEMENT_IDS.COMPARE_BUTTON, 'click', () => {
      const baseFile = safeGetElementValue(BASE_FILE);
      const editedFile = safeGetElementValue(EDITED_FILE);
      if (baseFile && editedFile) {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.COMPARE,
          baseFile,
          editedFile,
        });
      } else {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
          text: 'Please select both base and edited files to compare',
        });
      }
    });

    this.addListener(ELEMENT_IDS.ACCEPT_BUTTON, 'click', () => {
      const baseFile = safeGetElementValue(BASE_FILE);
      const editedFile = safeGetElementValue(EDITED_FILE);
      if (baseFile && editedFile) {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.ACCEPT_EDITED,
          baseFile,
          editedFile,
        });
      } else {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
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

  _normalizeSessionType(rawType) {
    return rawType === SESSION_TYPES.TOOL_USE
      ? SESSION_TYPES.TOOL_USE
      : SESSION_TYPES.WORKFLOW;
  }

  _getActiveAgentSelection() {
    const rawSessionType = safeGetElementValue(SESSION_TYPE_INPUT);
    const sessionType = this._normalizeSessionType(rawSessionType);
    const selectId = AGENT_SELECT_IDS[sessionType];
    const agent = selectId ? (safeGetElementValue(selectId) ?? '') : '';
    const selectElement = selectId ? safeGetElementById(selectId) : null;
    return {
      agent,
      sessionType,
      selectElement:
        selectElement instanceof HTMLSelectElement ? selectElement : null,
    };
  }
}
