// Local imports - webview
import { ELEMENT_IDS, BASE_FILE, EDITED_FILE } from '../constants.js';
import { BaseUIManager } from './BaseUIManager.js';
import { collectCurrentContext } from '../state/currentContext.js';
import { safeGetElementById, safeGetElementValue } from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class ActionButtonManager extends BaseUIManager {
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
          progressContainer.style.display = 'flex';
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

      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: `Running LaTeX diff between ${baseFile} and ${editedFile}`,
      });
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
}
