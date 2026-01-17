// Local imports - webview
import {
  ELEMENT_IDS,
  BASE_FILE,
  EDITED_FILE,
  SINGLE_FILE_ELEMENTS,
  MULTIPLE_SELECTIONS,
  CHECK_BOXES_AUTO_EXTRACT,
  SESSION_TYPES,
  parseSessionType,
} from '../constants.js';
import { BaseDomHandler } from '@common/BaseDomHandler.js';
import { collectCurrentContext } from '../state/currentContext.js';
import {
  safeGetElementById,
  safeGetElementValue,
  safeSetElementValue,
  safeSetElementChecked,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class ActionButtonManager extends BaseDomHandler {
  constructor(vscodeInstance = vscode, fileList, state) {
    super();
    this.vscode = vscodeInstance;
    this.fileList = fileList;
    this.state = state;
  }

  _setupInstructionButtons() {
    this.addListener(ELEMENT_IDS.ERASE_INSTRUCTION_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction) {
        instruction.value = '';
        this.state.save();
      }
    });

    this.addListener(ELEMENT_IDS.MAGIC_POLISH_BUTTON, 'click', () => {
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction && instruction.value.trim()) {
        const { agent, singleFileSelections, multipleFileSelections } =
          collectCurrentContext({ fileList: this.fileList });
        const model = safeGetElementValue('model');

        // Show progress indicator
        const progressContainer = document.getElementById(
          'polishProgressContainer',
        );
        if (progressContainer) {
          progressContainer.style.display = 'block';
        }

        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.POLISH_INSTRUCTION_TEXT,
          text: instruction.value,
          agent,
          model,
          ...singleFileSelections,
          ...multipleFileSelections,
        });
      }
    });
  }

  _setupExecuteButtons() {
    this.addListener(ELEMENT_IDS.EXECUTE_BUTTON, 'click', () => {
      const {
        agent,
        isToolUseAgent,
        singleFileSelections,
        multipleFileSelections,
        checkboxValues,
      } = collectCurrentContext({ fileList: this.fileList });
      const model = safeGetElementValue('model');
      const instruction = safeGetElementValue(ELEMENT_IDS.INSTRUCTION);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.EXECUTE,
        agent,
        model,
        instruction,
        isToolUseAgent,
        ...singleFileSelections,
        ...multipleFileSelections,
        ...checkboxValues,
      });
    });

    this.addListener(ELEMENT_IDS.MERGE_BUTTON, 'click', () => {
      const { singleFileSelections } = collectCurrentContext({
        fileList: this.fileList,
        singleFileTypes: ['input'],
      });
      const { inputFile } = singleFileSelections;
      const editedFile = safeGetElementValue(EDITED_FILE);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.MERGE,
        inputFile,
        editedFile,
      });

      this._showInfo(`Merging files: ${inputFile} and ${editedFile}`);
    });

    const packCleanCommands = {
      pack: {
        single: MAIN_VIEW_COMMANDS.PACK_SINGLE,
        multiple: MAIN_VIEW_COMMANDS.PACK_MULTIPLE,
      },
      clean: {
        single: MAIN_VIEW_COMMANDS.CLEAN_SINGLE,
        multiple: MAIN_VIEW_COMMANDS.CLEAN_MULTIPLE,
      },
    };

    [
      { id: ELEMENT_IDS.PACK_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this.addListener(id, 'click', () => {
        const { agent, singleFileSelections, multipleFileSelections } =
          collectCurrentContext({
            fileList: this.fileList,
            singleFileTypes: ['input'],
          });
        const { inputFile } = singleFileSelections;
        const model = safeGetElementValue('model');
        const outputFiles =
          multipleFileSelections[ELEMENT_IDS.OUTPUT_FILES] ?? [];
        const outputFilesActive =
          multipleFileSelections[`${ELEMENT_IDS.OUTPUT_FILES}Active`] ?? false;
        const useMultiple = outputFilesActive && outputFiles.length > 0;
        const commands = packCleanCommands[action];

        if (useMultiple) {
          this.vscode.postMessage({
            command: commands.multiple,
            inputFile,
            agent,
            model,
            outputFiles,
          });
          this._showInfo(
            `${capitalize(action)}ing multiple files: ${[inputFile, ...outputFiles].join(', ')}`,
          );
        } else {
          if (!inputFile || !agent || !model) {
            this._showInfo(
              'Please select all required fields (input file, agent, and model)',
            );
            return;
          }
          this.vscode.postMessage({
            command: commands.single,
            inputFile,
            agent,
            model,
          });
          this._showInfo(`${capitalize(action)}ing single file: ${inputFile}`);
        }
      });
    });
  }

  _showInfo(text) {
    this.vscode.postMessage({
      command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
      text,
    });
  }

  _setupLatexdiffButtons() {
    this.addListener(ELEMENT_IDS.LATEXDIFF_BUTTON, 'click', () => {
      const { singleFileSelections } = collectCurrentContext({
        fileList: this.fileList,
        singleFileTypes: ['input'],
      });
      const { inputFile } = singleFileSelections;
      const baseFile = safeGetElementValue(BASE_FILE);
      const editedFile = safeGetElementValue(EDITED_FILE);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.LATEXDIFF,
        inputFile,
        baseFile,
        editedFile,
      });

      this._showInfo(
        `Running LaTeX diff between ${baseFile} and ${editedFile}`,
      );
    });

    this.addListener(ELEMENT_IDS.LATEXDIFF_VC_BUTTON, 'click', () => {
      const { singleFileSelections } = collectCurrentContext({
        fileList: this.fileList,
        singleFileTypes: ['input'],
      });
      const { inputFile } = singleFileSelections;
      const baseFile = safeGetElementValue(BASE_FILE);
      const commitHash = safeGetElementValue(ELEMENT_IDS.COMMIT_SELECT);

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.LATEXDIFFVC,
        inputFile,
        baseFile,
        commitHash,
      });

      this._showInfo(
        `Running LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
      );
    });

    [
      { id: ELEMENT_IDS.PACK_LATEXDIFF_VC_BUTTON, action: 'pack' },
      { id: ELEMENT_IDS.CLEAN_LATEXDIFF_VC_BUTTON, action: 'clean' },
    ].forEach(({ id, action }) => {
      this.addListener(id, 'click', () => {
        const { singleFileSelections } = collectCurrentContext({
          fileList: this.fileList,
          singleFileTypes: ['input'],
        });
        const { inputFile } = singleFileSelections;
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

        this._showInfo(
          `${capitalize(action)}ing LaTeX diff with version control: ${baseFile} at commit ${commitHash}`,
        );
      });
    });
  }

  _setupCompareButtons() {
    const setupCompareHandler = (buttonId, command, actionText) => {
      this.addListener(buttonId, 'click', () => {
        const baseFile = safeGetElementValue(BASE_FILE);
        const editedFile = safeGetElementValue(EDITED_FILE);
        if (baseFile && editedFile) {
          this.vscode.postMessage({ command, baseFile, editedFile });
        } else {
          this._showInfo(
            `Please select both base and edited files to ${actionText}`,
          );
        }
      });
    };

    setupCompareHandler(
      ELEMENT_IDS.COMPARE_BUTTON,
      MAIN_VIEW_COMMANDS.COMPARE,
      'compare',
    );
    setupCompareHandler(
      ELEMENT_IDS.ACCEPT_BUTTON,
      MAIN_VIEW_COMMANDS.ACCEPT_EDITED,
      'accept changes',
    );
  }

  _setupNewSessionButton() {
    this.addListener(ELEMENT_IDS.NEW_SESSION_BUTTON, 'click', () => {
      const sessionType = parseSessionType(safeGetElementValue('sessionType'));
      const isToolUseSession = sessionType === SESSION_TYPES.TOOL_USE;

      // Always clear the instruction
      const instruction = safeGetElementById(ELEMENT_IDS.INSTRUCTION);
      if (instruction) {
        instruction.value = '';
      }

      if (isToolUseSession) {
        // Chat mode: Clear instruction only
        // (conversation history is managed separately in progress view)
      } else {
        // Workflow mode: Clear instruction + file selections + checkboxes
        this._clearWorkflowView();
      }

      this.state.save();
    });
  }

  _clearWorkflowView() {
    // Clear single file selections
    SINGLE_FILE_ELEMENTS.forEach((id) => {
      safeSetElementValue(id, '');
    });

    // Clear multiple file selections
    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      this.fileList.empty(id, toggleId, false);
    });

    // Uncheck auto-extract checkboxes
    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      safeSetElementChecked(id, false);
    });
  }

  setup() {
    this._setupInstructionButtons();
    this._setupExecuteButtons();
    this._setupLatexdiffButtons();
    this._setupCompareButtons();
    this._setupNewSessionButton();
  }
}
