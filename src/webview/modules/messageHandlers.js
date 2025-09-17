// Local imports - webview
import {
  FILE_TYPES,
  INPUT_FILE,
  REFERENCE_FILE,
  AUXILIARY_FILE,
  MEDIA_FILE,
  EDITED_FILE,
  BASE_FILE,
  ELEMENT_IDS,
} from './constants.js';
import { webviewEventBus } from './eventBus.js';
import { createFileHandlers } from './handlers/fileHandlers.js';
import { createRecordingHandlers } from './handlers/recordingHandlers.js';

// Handler submodules
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { mainViewState } from './mainViewState.js';

// Local imports - UI managers
import { fileSelect } from './uiManagers/FileSelect.js';
import { bannerManager } from './uiManagers/BannerManager.js';
import {
  safeSetElementValue,
  safeGetElementById,
  setChevronIcon,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import { createFromTemplate } from '@common/templateUtils.js';

// Import standardized commands
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
// Local imports - webview context
import { vscode } from '@common/webviewContext.js';
import { BaseWebviewMessageHandler } from '@common/BaseWebviewMessageHandler.js';

/**
 * Handles messages from the extension and syncs the webview state.
 */
export class MainViewMessageHandler extends BaseWebviewMessageHandler {
  constructor() {
    super();
    this._skipNextRestoreState = false;

    // Cached DOM elements
    this._instructionEl = null;
    this._elementCache = new Map();
    // Track file list event handlers for cleanup
    this._fileListHandlers = {};
    // Flag to prevent concurrent retry attempts for model options
    this._modelOptionsRetryInProgress = false;

    const ctx = {
      postHandle: this._postHandle.bind(this),
      getElement: this._getElement.bind(this),
      setToggleIcon: this._setToggleIcon.bind(this),
      setupFileListHandler: this._setupFileListHandler.bind(this),
    };

    this._handlers = {
      ...createThemeHandlers({ postHandle: ctx.postHandle }),
      ...this._createStateHandlers(),
      ...this._createInstructionHandlers(),
      ...createRecordingHandlers({ postHandle: ctx.postHandle }),
      ...createFileHandlers(ctx),
      [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (m) =>
        bannerManager.showBanner(ELEMENT_IDS.API_KEY_BANNER, m),
      [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () =>
        bannerManager.hideBanner(ELEMENT_IDS.API_KEY_BANNER),
      [MAIN_VIEW_COMMANDS.SHOW_AGENT_CONFIG_BANNER]: (m) =>
        bannerManager.showBanner(ELEMENT_IDS.AGENT_CONFIG_BANNER, m),
      [MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER]: () =>
        bannerManager.hideBanner(ELEMENT_IDS.AGENT_CONFIG_BANNER),
      [MAIN_VIEW_COMMANDS.SHOW_DEPENDENCY_BANNER]: (m) =>
        webviewEventBus.dispatchEvent(
          new CustomEvent('showDependencyBanner', { detail: m }),
        ),
      [MAIN_VIEW_COMMANDS.HIDE_DEPENDENCY_BANNER]: () =>
        webviewEventBus.dispatchEvent(new CustomEvent('hideDependencyBanner')),
      [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: (m) => {
        // Validate that options are provided
        if (!m.options) {
          console.warn('SET_MODEL_OPTIONS: No options provided');
          return;
        }

        // Helper function to apply options to select element
        const applyOptions = (selectElement) => {
          const previous = selectElement.value;
          selectElement.innerHTML = m.options;
          if (previous) {
            selectElement.value = previous;
          }
          Array.from(selectElement.options).forEach((opt) => {
            // Note: disabled-model class is already set server-side in computeModelOptions
            // We only need to add tooltips here
            const { provider, context, cost } = opt.dataset;
            if (provider || context || cost) {
              opt.title = `Provider: ${provider ?? 'N/A'}, Context: ${context ?? 'N/A'}, Cost: ${cost ?? 'N/A'}`;
            }
          });
        };

        // Don't cache if element doesn't exist yet
        const select = document.getElementById('model');
        if (!select) {
          // Prevent concurrent retry attempts
          if (this._modelOptionsRetryInProgress) {
            console.warn('SET_MODEL_OPTIONS: Retry already in progress');
            return;
          }

          // Use a more robust retry mechanism with exponential backoff
          this._modelOptionsRetryInProgress = true;
          let retryCount = 0;
          const maxRetries = 5;
          const retryDelay = [100, 200, 400, 800, 1600];

          const tryApplyOptions = () => {
            const retrySelect = document.getElementById('model');
            if (retrySelect) {
              applyOptions(retrySelect);
              this._modelOptionsRetryInProgress = false;
            } else if (retryCount < maxRetries) {
              setTimeout(tryApplyOptions, retryDelay[retryCount]);
              retryCount++;
            } else {
              console.warn(
                'SET_MODEL_OPTIONS: Model select element not found after retries',
              );
              this._modelOptionsRetryInProgress = false;
            }
          };

          setTimeout(tryApplyOptions, retryDelay[0]);
          retryCount = 1;
          return;
        }

        applyOptions(select);
      },
      [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (m) => {
        if (!m.options) {
          console.warn('SET_AGENT_OPTIONS: No options provided');
          return;
        }
        const select = document.getElementById('agent');
        if (!select) {
          console.warn('SET_AGENT_OPTIONS: Agent select element not found');
          return;
        }
        const previous = select.value;
        select.innerHTML = m.options;
        if (previous) {
          select.value = previous;
        }
        Array.from(select.options).forEach((opt) => {
          const originalLabel = opt.dataset.label
            ? opt.dataset.label
            : (() => {
                let text = opt.textContent ?? '';
                if (text.endsWith('ᵗ')) {
                  text = text.slice(0, -1);
                }
                if (text.endsWith(' ∶∶')) {
                  text = text.slice(0, -3);
                }
                return text;
              })();
          opt.dataset.label = originalLabel;

          let displayLabel = originalLabel;
          const hints = [];

          if (opt.dataset.multiple === 'true') {
            displayLabel = `${displayLabel} ∶∶`;
            hints.push('Supports multi-file inputs.');
          }

          if (opt.dataset.toolUse === 'true') {
            displayLabel = `${displayLabel}ᵗ`;
            hints.push('Uses tools for actions.');
          }

          opt.textContent = displayLabel;
          opt.style.opacity = opt.dataset.multiple === 'true' ? '0.9' : '';

          if (hints.length > 0) {
            const tooltip = hints.join('\n');
            const ariaDescription = hints.join(', ');
            opt.title = tooltip;
            opt.setAttribute(
              'aria-label',
              `${originalLabel} (${ariaDescription})`,
            );
          } else {
            opt.removeAttribute('title');
            opt.setAttribute('aria-label', originalLabel);
          }
        });
      },
    };
  }

  _createStateHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.STATE_RESTORE]: (m) => this.handleRestoreState(m),
      [MAIN_VIEW_COMMANDS.CHECK_RESTORED_BASE_FILE]: () =>
        this.handleCheckRestoredBaseFile(),
    };
  }

  _createInstructionHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]: (m) =>
        this.handleInstructionTextPolished(m),
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (m) =>
        this.handleInstructionTextTranscribed(m),
    };
  }

  /** Register handlers and optionally request initial data. */
  setup(options = {}) {
    const { requestData = true } = options;
    super.setup();
    if (requestData) {
      this._initializeDataRequests();
    }
  }

  cleanup() {
    super.cleanup();
    Object.values(this._fileListHandlers).forEach(({ container, handler }) => {
      container.removeEventListener('click', handler);
    });
    this._fileListHandlers = {};
    this._instructionEl = null;
    this._elementCache.clear();
  }

  /* ---------- Private helpers ---------- */
  _setToggleIcon(element, isVisible) {
    if (!element) return;
    setChevronIcon(element, isVisible);
  }

  _createFileItem(file) {
    const element = createFromTemplate('fileListEntryTemplate', {
      text: { '.file-name': file },
      dataset: { '': { path: file } },
    });
    if (element) return element;

    const fileItem = document.createElement('div');
    fileItem.className = 'file-item';
    fileItem.dataset.path = file;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = file;
    fileItem.appendChild(nameSpan);

    const removeButton = document.createElement('span');
    removeButton.className = 'remove-button';
    removeButton.textContent = '-';
    fileItem.appendChild(removeButton);

    return fileItem;
  }

  _setupFileListHandler(fileType, container) {
    if (!container || this._fileListHandlers[fileType]) return;
    const handler = (e) => {
      if (
        e.target instanceof HTMLElement &&
        e.target.classList.contains('remove-button')
      ) {
        e.stopPropagation();
        const item = e.target.closest('.file-item');
        if (item) {
          item.remove();
          const updated = Array.from(
            container.querySelectorAll('.file-item'),
          ).map((el) => el.dataset.path);
          const updateCommands = {
            input: MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES,
            reference: MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES,
            auxiliary: MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES,
            media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
            output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
          };
          vscode.postMessage({
            command: updateCommands[fileType],
            files: updated,
          });
          mainViewState.update({ [`${fileType}Files`]: updated });
        }
      }
    };
    container.addEventListener('click', handler);
    this._fileListHandlers[fileType] = { container, handler };
  }

  _getElement(id) {
    if (!this._elementCache.has(id)) {
      this._elementCache.set(id, safeGetElementById(id));
    }
    return this._elementCache.get(id);
  }

  _initializeDataRequests() {
    const dataRequests = [
      MAIN_VIEW_COMMANDS.GET_THEME,
      MAIN_VIEW_COMMANDS.GET_DEBUG_MODE,
      MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
      MAIN_VIEW_COMMANDS.REQUEST_RECENT_COMMITS,
      MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE,
    ];
    dataRequests.forEach((command) => {
      vscode.postMessage({ command });
    });

    // Also request default output files for the current agent
    const agentElement = this._getElement('agent');
    if (agentElement && agentElement.value) {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: agentElement.value,
      });
    }
  }

  _handleStateRestoration(state) {
    console.log('Restoring state:', state);

    const config = state.agentConfig || state;
    const activeFiles = state.activeFiles || {};

    const savedState = {};
    this._restoreFormFields(config, savedState);
    this._restoreFileArrays(config, savedState, activeFiles);
    mainViewState.set(savedState);
    mainViewState.restore();
    this._skipNextRestoreState = true;
  }

  _restoreFormFields(state, savedState) {
    if (state.agent) safeSetElementValue('agent', state.agent);
    if (state.model) safeSetElementValue('model', state.model);

    const instructionContent = state.instruction || '';
    const instruction =
      this._instructionEl ||
      (this._instructionEl = this._getElement('instruction'));
    if (instruction) {
      instruction.value = instructionContent;
      instruction.dispatchEvent(new Event('input'));
    }

    if (state.inputFile) safeSetElementValue(INPUT_FILE, state.inputFile);
    if (state.referenceFile)
      safeSetElementValue(REFERENCE_FILE, state.referenceFile);
    if (state.auxiliaryFile)
      safeSetElementValue(AUXILIARY_FILE, state.auxiliaryFile);
    if (state.mediaFile) safeSetElementValue(MEDIA_FILE, state.mediaFile);

    const toolConfig = state.toolConfig || {};
    Object.assign(savedState, {
      agent: state.agent,
      model: state.model,
      instruction: instructionContent,
      inputFile: state.inputFile,
      referenceFile: state.referenceFile,
      auxiliaryFile: state.auxiliaryFile,
      mediaFile: state.mediaFile,
      reflect: state.reflect ?? toolConfig.reflect ?? false,
      autoExtractFigure:
        state.autoExtractFigure ?? toolConfig.autoExtractFigure ?? false,
      autoExtractTikzFigure:
        state.autoExtractTikzFigure ??
        toolConfig.autoExtractTikzFigure ??
        false,
      attachTeXCount:
        state.attachTeXCount ?? toolConfig.attachTeXCount ?? false,
      attachDiagnostics:
        state.attachDiagnostics ?? toolConfig.attachDiagnostics ?? false,
      printInputPrompt:
        state.printInputPrompt ?? toolConfig.printInputPrompt ?? false,
      autoCompileInputPdf:
        state.autoCompileInputPdf ?? toolConfig.autoCompileInputPdf ?? false,
    });
  }

  _restoreFileArrays(state, savedState, activeFiles = {}) {
    for (const fileType of FILE_TYPES) {
      const filesArray =
        state[`${fileType}Files`] ||
        state[`multiple${capitalize(fileType)}Files`] ||
        [];
      const isVisible =
        activeFiles[fileType] ||
        state[`${fileType}FilesActive`] ||
        state[`multiple${capitalize(fileType)}FilesActive`] ||
        false;

      const targetArrayName = `${fileType}Files`;
      const visibilityName = `${targetArrayName}Active`;
      savedState[targetArrayName] = filesArray;
      savedState[visibilityName] = isVisible;

      const multipleFilesId = `${fileType}Files`;
      const multipleFiles = this._getElement(multipleFilesId);
      if (filesArray.length > 0 || isVisible) {
        const containerId = `${fileType}FilesContainer`;
        const toggleId = `toggle${capitalize(fileType)}Files`;

        const container = this._getElement(containerId);
        if (container) {
          container.style.display = isVisible ? 'block' : 'none';
        }

        const toggleElement = this._getElement(toggleId);
        this._setToggleIcon(toggleElement, isVisible);

        if (filesArray.length > 0 && multipleFiles) {
          multipleFiles.innerHTML = '';
          filesArray.forEach((file) => {
            multipleFiles.appendChild(this._createFileItem(file));
          });
          this._setupFileListHandler(fileType, multipleFiles);
        }
      }
    }
  }

  _postHandle() {
    if (this._skipNextRestoreState) {
      this._skipNextRestoreState = false;
    } else {
      mainViewState.restore();
    }
  }

  /* ---------- Command handlers ---------- */

  // State restoration
  handleRestoreState(message) {
    this._handleStateRestoration(message.state);
    this._postHandle();
  }

  handleCheckRestoredBaseFile() {
    const restoredBaseFileDiv = this._getElement(BASE_FILE);
    if (restoredBaseFileDiv && restoredBaseFileDiv.value) {
      fileSelect.updateEdited(restoredBaseFileDiv.value);
    }
    this._postHandle();
  }

  // Instruction updates
  handleInstructionTextPolished(message) {
    const instruction = this._getElement('instruction');
    if (instruction && message.text) {
      instruction.value = message.text;
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: 'Instruction text has been polished!',
      });
      mainViewState.save();
    }
    this._postHandle();
  }

  handleInstructionTextTranscribed(message) {
    const instruction = this._getElement('instruction');
    if (instruction && message.text) {
      const startPos = instruction.selectionStart;
      const endPos = instruction.selectionEnd;
      const textBefore = instruction.value.substring(0, startPos);
      const textAfter = instruction.value.substring(endPos);
      instruction.value = textBefore + message.text + textAfter;
      const newCursorPos = startPos + message.text.length;
      instruction.setSelectionRange(newCursorPos, newCursorPos);
      instruction.focus();
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: 'Instruction text transcribed!',
      });
      mainViewState.save();
    }
    webviewEventBus.dispatchEvent(
      new CustomEvent('recordingUIUpdate', { detail: { recording: false } }),
    );
    this._postHandle();
  }
}

const handler = new MainViewMessageHandler();
export const setup = handler.setup.bind(handler);
export const cleanup = handler.cleanup.bind(handler);
