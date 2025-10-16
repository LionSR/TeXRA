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
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
  AGENT_SELECT_LIST,
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
 * Waits for a DOM element matching the provided selector.
 *
 * Uses a MutationObserver to watch for DOM changes until the element appears.
 * If the element already exists, returns immediately. Supports optional timeout.
 *
 * @param {string} selector - CSS selector to match the desired element
 * @param {Object} [options] - Optional configuration
 * @param {number} [options.timeout] - Maximum time to wait in milliseconds (default: no timeout)
 * @returns {{ promise: Promise<Element | null>, dispose: () => void }}
 *          Returns an object with:
 *          - promise: Resolves with the element or null if disposed/timeout
 *          - dispose: Function to cancel the wait and clean up resources
 *
 * @example
 * const { promise, dispose } = waitForElement('#model', { timeout: 5000 });
 * const element = await promise;
 * if (element) {
 *   // Use the element
 * }
 */
function waitForElement(selector, options = {}) {
  const existing = document.querySelector(selector);
  if (existing) {
    return {
      promise: Promise.resolve(existing),
      dispose: () => {},
    };
  }

  let observer = null;
  let resolver = null;
  let timeoutId = null;

  const promise = new Promise((resolve) => {
    resolver = resolve;

    // Set up optional timeout
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (resolver) {
          resolver = null;
          resolve(null);
        }
      }, options.timeout);
    }

    observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) {
        return;
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      resolver = null;
      resolve(element);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  });

  const dispose = () => {
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (resolver) {
      const resolve = resolver;
      resolver = null;
      resolve(null);
    }
  };

  return { promise, dispose };
}

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
    // Track pending model option updates until the select element is ready
    this._disposeModelWaiter = null;
    this._isDisposed = false;

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
      /**
       * Handles SET_MODEL_OPTIONS command to update the model dropdown.
       *
       * Waits for the #model select element to appear in the DOM before applying options.
       * Uses a disposer pattern to handle race conditions when multiple SET_MODEL_OPTIONS
       * messages arrive before the element is ready.
       *
       * Disposer pattern explained:
       * - Store a reference to the current disposer function in this._disposeModelWaiter
       * - If a new wait starts before the old one finishes, dispose the old waiter
       * - Use identity checks (disposeHandle === this._disposeModelWaiter) to detect
       *   if this waiter was superseded by a newer one during the await
       * - This prevents stale waiters from applying outdated model options
       */
      [MAIN_VIEW_COMMANDS.SET_MODEL_OPTIONS]: async (m) => {
        // Validate that options are provided
        if (!m.options) {
          console.warn('SET_MODEL_OPTIONS: No options provided');
          return;
        }

        let select = document.getElementById('model');
        if (!(select instanceof HTMLSelectElement)) {
          const waitHandle = waitForElement('#model');

          // Cancel any previous waiter to prevent race conditions
          if (this._disposeModelWaiter) {
            this._disposeModelWaiter();
          }

          // Create a disposer that cleans up this specific waiter
          const disposeHandle = () => {
            waitHandle.dispose();
            // Only clear _disposeModelWaiter if this is still the active waiter
            if (this._disposeModelWaiter === disposeHandle) {
              this._disposeModelWaiter = null;
            }
          };
          this._disposeModelWaiter = disposeHandle;

          select = await waitHandle.promise;

          // Check if this waiter is still active after the await
          // If not, a newer waiter has taken over, so we should abort
          if (this._disposeModelWaiter === disposeHandle) {
            this._disposeModelWaiter = null;
          }
        }

        if (this._isDisposed) {
          return;
        }

        if (!(select instanceof HTMLSelectElement)) {
          console.warn('SET_MODEL_OPTIONS: Model select element not found');
          return;
        }
        this._applyModelOptions(select, m.options);
      },
      [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: (m) => {
        const optionsPayload = m.options ?? {};
        let applied = false;

        [
          {
            id: AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
            html: optionsPayload.workflow ?? '',
          },
          {
            id: AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
            html: optionsPayload.toolUse ?? '',
          },
        ].forEach(({ id, html }) => {
          if (!id) {
            return;
          }
          const select = document.getElementById(id);
          if (!(select instanceof HTMLSelectElement)) {
            return;
          }
          this._applyAgentOptions(select, html);
          applied = true;
        });

        if (!applied) {
          console.warn('SET_AGENT_OPTIONS: Agent select elements not found');
        }
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

  _applyModelOptions(selectElement, optionsHtml) {
    const previous = selectElement.value;
    selectElement.innerHTML = optionsHtml;
    if (previous) {
      selectElement.value = previous;
    }
    Array.from(selectElement.options).forEach((opt) => {
      const { provider, context, cost } = opt.dataset;
      if (provider || context || cost) {
        opt.title = `Provider: ${provider ?? 'N/A'}, Context: ${context ?? 'N/A'}, Cost: ${cost ?? 'N/A'}`;
      }
    });
  }

  _applyAgentOptions(selectElement, optionsHtml) {
    const previous = selectElement.value;
    selectElement.innerHTML = optionsHtml ?? '';
    if (previous) {
      selectElement.value = previous;
      if (
        selectElement.value !== previous &&
        selectElement.options.length > 0
      ) {
        const fallbackOption = Array.from(selectElement.options).find(
          (option) => !option.disabled,
        );
        if (fallbackOption) {
          selectElement.value = fallbackOption.value;
        }
      }
    }

    Array.from(selectElement.options).forEach((opt) => {
      this._decorateAgentOption(opt);
    });
  }

  _decorateAgentOption(opt) {
    const { label, isMultiple, isToolUse } = this._readAgentOptionMetadata(opt);

    const hints = [];
    let displayLabel = label;

    if (isMultiple) {
      displayLabel += ' ∶∶';
      hints.push('Supports multi-file inputs.');
      opt.style.opacity = '0.9';
    } else {
      opt.style.opacity = '';
    }

    if (isToolUse) {
      hints.push('Uses tools for actions.');
    }

    opt.textContent = displayLabel;

    if (hints.length > 0) {
      opt.title = hints.join('\n');
      opt.setAttribute('aria-label', `${label} (${hints.join(', ')})`);
      opt.setAttribute('aria-description', hints.join(' '));
    } else {
      opt.removeAttribute('title');
      opt.setAttribute('aria-label', label);
      opt.removeAttribute('aria-description');
    }
  }

  _readAgentOptionMetadata(opt) {
    let label = opt.dataset.label ?? '';
    if (!label) {
      const textLabel = opt.textContent?.trim();
      if (textLabel) {
        label = textLabel;
      } else {
        const valueAttr = opt.getAttribute('value');
        label = valueAttr ?? '';
      }
      if (label) {
        opt.dataset.label = label;
      }
    }

    return {
      label,
      isMultiple: opt.dataset.multiple === 'true',
      isToolUse: opt.dataset.toolUse === 'true',
    };
  }

  _getSessionTypeValue() {
    const input = this._getElement(SESSION_TYPE_INPUT);
    const rawValue = input?.value ?? '';
    return rawValue === SESSION_TYPES.TOOL_USE
      ? SESSION_TYPES.TOOL_USE
      : SESSION_TYPES.WORKFLOW;
  }

  _getAgentElementByType(sessionType) {
    const selectId = AGENT_SELECT_IDS[sessionType];
    if (!selectId) {
      return null;
    }
    const element = this._getElement(selectId);
    return element instanceof HTMLSelectElement ? element : null;
  }

  _getActiveAgentSelection() {
    const sessionType = this._getSessionTypeValue();
    const select = this._getAgentElementByType(sessionType);
    const value = select?.value ?? '';
    return { sessionType, select, value };
  }

  /** Register handlers and optionally request initial data. */
  setup(options = {}) {
    const { requestData = true } = options;
    this._isDisposed = false;
    if (this._disposeModelWaiter) {
      this._disposeModelWaiter();
      this._disposeModelWaiter = null;
    }
    super.setup();
    if (requestData) {
      this._initializeDataRequests();
    }
  }

  cleanup() {
    this._isDisposed = true;
    if (this._disposeModelWaiter) {
      this._disposeModelWaiter();
      this._disposeModelWaiter = null;
    }

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
    const { value: agentValue } = this._getActiveAgentSelection();
    if (agentValue) {
      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: agentValue,
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
    const sessionType = state.sessionType
      ? state.sessionType
      : state.isToolUseAgent
        ? SESSION_TYPES.TOOL_USE
        : SESSION_TYPES.WORKFLOW;
    const workflowAgentValue =
      state.workflowAgent ??
      (!state.isToolUseAgent ? state.agent : undefined) ??
      '';
    const toolUseAgentValue =
      state.toolUseAgent ??
      (state.isToolUseAgent ? state.agent : undefined) ??
      '';

    safeSetElementValue(SESSION_TYPE_INPUT, sessionType);
    safeSetElementValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      workflowAgentValue,
    );
    safeSetElementValue(
      AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
      toolUseAgentValue,
    );
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
      sessionType,
      workflowAgent: workflowAgentValue,
      toolUseAgent: toolUseAgentValue,
      agent:
        state.agent ??
        (sessionType === SESSION_TYPES.TOOL_USE
          ? toolUseAgentValue
          : workflowAgentValue),
      model: state.model,
      instruction: instructionContent,
      inputFile: state.inputFile,
      referenceFile: state.referenceFile,
      auxiliaryFile: state.auxiliaryFile,
      mediaFile: state.mediaFile,
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
