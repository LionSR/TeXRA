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
  normalizeSessionType,
} from './constants.js';
import { webviewEventBus } from './eventBus.js';
import { createFileHandlers } from './handlers/fileHandlers.js';
import { createRecordingHandlers } from './handlers/recordingHandlers.js';
import { recordingManager } from './domHandlers.js';

// Handler submodules
import { createThemeHandlers } from './handlers/themeHandlers.js';
import { mainViewState } from './mainViewState.js';

// Local imports - UI managers
import { fileSelect } from './uiManagers/FileSelect.js';
import { bannerManager } from './uiManagers/BannerManager.js';
import {
  hideModelApiKeyBanner,
  updateModelApiKeyBanner,
} from './uiManagers/apiKeyBannerUtils.js';
import { fileList } from './uiManagers/FileList.js';
import {
  safeSetElementValue,
  safeGetElementById,
  setChevronIcon,
  waitForElement,
  isSelectLikeElement,
  getSelectOptionElements,
  getSelectedOptionElement,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import {
  AGENT_DECORATORS,
  getAgentTypeDecorator,
  getModelProviderDecorator,
} from '@common/iconConstants.js';

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
    // Track pending model option updates until the select element is ready
    this._disposeModelWaiter = null;
    this._isDisposed = false;
    // Track tooltip listeners for cleanup
    this._tooltipListeners = [];

    const ctx = {
      postHandle: this._postHandle.bind(this),
      getElement: this._getElement.bind(this),
      setToggleIcon: this._setToggleIcon.bind(this),
    };

    this._registerFileListCallbacks();

    this._handlers = {
      ...createThemeHandlers({ postHandle: ctx.postHandle }),
      ...this._createStateHandlers(),
      ...this._createInstructionHandlers(),
      ...createRecordingHandlers({ postHandle: ctx.postHandle }),
      ...createFileHandlers(ctx),
      [MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER]: (m) =>
        updateModelApiKeyBanner(this._getElement('model'), m, {
          forceShow: true,
        }),
      [MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER]: () => hideModelApiKeyBanner(),
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
        if (!isSelectLikeElement(select)) {
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
          // If not, a newer waiter has taken over, so abort
          if (this._disposeModelWaiter !== disposeHandle) {
            return;
          }
          this._disposeModelWaiter = null;

          // Check if disposed during await
          if (this._isDisposed) {
            return;
          }

          // Verify element was found
          if (!isSelectLikeElement(select)) {
            console.warn(
              'SET_MODEL_OPTIONS: Model select element not found after waiting',
            );
            return;
          }
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
          if (!isSelectLikeElement(select)) {
            return;
          }
          this._applyAgentOptions(select, html);
          applied = true;
        });

        if (!applied) {
          console.warn('SET_AGENT_OPTIONS: Agent select elements not found');
        }
      },
      /**
       * Sets the selected agent in the dropdown without triggering full state restoration.
       * Used by profile page to select a remote agent without clearing other fields.
       * Handles name conflicts: if exact source:name not found, selects by name (any source).
       * @param {Object} m - Message with agentValue and optional sessionType
       * @param {string} m.agentValue - The agent value (in source:name format)
       * @param {string} [m.sessionType] - 'workflow' or 'toolUse' (defaults to 'workflow')
       */
      [MAIN_VIEW_COMMANDS.SET_SELECTED_AGENT]: (m) => {
        const { agentValue, sessionType } = m;
        if (!agentValue) {
          console.warn('SET_SELECTED_AGENT: No agentValue provided');
          return;
        }

        // Determine which dropdown to update
        const targetSessionType =
          sessionType === SESSION_TYPES.TOOL_USE
            ? SESSION_TYPES.TOOL_USE
            : SESSION_TYPES.WORKFLOW;

        // Switch session type UI if needed (shows correct dropdown, updates radio buttons)
        mainViewState.applySessionType(targetSessionType);

        const selectId = AGENT_SELECT_IDS[targetSessionType];

        if (!selectId) {
          console.warn(
            `SET_SELECTED_AGENT: No select ID for session type: ${targetSessionType}`,
          );
          return;
        }

        const selectElement = document.getElementById(selectId);
        if (!selectElement) {
          console.warn(
            `SET_SELECTED_AGENT: Select element not found: ${selectId}`,
          );
          return;
        }

        // Find the best matching option
        let targetValue = agentValue;
        const options = Array.from(selectElement.children);

        // First try exact match
        let matchingOption = options.find((opt) => opt.value === agentValue);

        // If no exact match, try to find by name (handles deduplication conflicts)
        // E.g., "remote:logic" not found but "custom:logic" exists → select custom:logic
        if (!matchingOption) {
          const parsed = this._parseAgentKey(agentValue);
          if (parsed) {
            // Find option with matching name (any source)
            matchingOption = options.find((opt) => {
              const optParsed = this._parseAgentKey(opt.value);
              return optParsed && optParsed.name === parsed.name;
            });
            if (matchingOption) {
              targetValue = matchingOption.value;
              console.info(
                `SET_SELECTED_AGENT: Using ${targetValue} instead of ${agentValue} (name match)`,
              );
            }
          }
        }

        // Set the value (creates placeholder if still no match)
        this._setAgentValue(selectId, targetValue);

        // Update mainViewState to persist the selection
        const stateKey =
          targetSessionType === SESSION_TYPES.TOOL_USE
            ? 'toolUseAgent'
            : 'workflowAgent';
        mainViewState.update({ [stateKey]: targetValue });

        // Decorate the placeholder option if it was just created
        // Re-query children since _setAgentValue may have added a new option
        const currentOptions = Array.from(selectElement.children);
        const option = currentOptions.find((opt) => opt.value === targetValue);
        if (option && !option.dataset.decorated) {
          this._decorateAgentOption(option);
          option.dataset.decorated = 'true';
        }

        // Update the select's tooltip
        this._updateAgentSelectTooltip(selectElement);
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
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]: (m) =>
        this.handleInstructionTextPolishError(m),
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]: (m) =>
        this.handleInstructionTextTranscribed(m),
    };
  }

  _applyModelOptions(selectElement, optionsHtml) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }
    const previous = selectElement.value;
    selectElement.innerHTML = optionsHtml;
    this._restoreModelSelection(selectElement, previous);
    getSelectOptionElements(selectElement).forEach((opt) => {
      this._decorateModelOption(opt);
    });

    updateModelApiKeyBanner(selectElement);
  }

  _decorateModelOption(opt) {
    const { provider, context, cost } = opt.dataset;
    const modelName =
      opt.textContent?.trim() ?? opt.getAttribute('value') ?? '';

    // Get provider decorator for the icon
    const decorator = getModelProviderDecorator(provider);
    const displayLabel = `${decorator.unicode} ${modelName}`;

    // Build tooltip with provider info
    const hints = [];
    hints.push(`${decorator.label}`);
    if (context) hints.push(`Context: ${context}`);
    if (cost) hints.push(`Cost: ${cost}`);

    // Set text content with provider icon
    opt.textContent = displayLabel;

    if (hints.length > 0) {
      opt.title = hints.join(' | ');
      opt.setAttribute('aria-label', `${modelName} (${hints.join(', ')})`);
    }
  }

  _applyAgentOptions(selectElement, optionsHtml) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }
    const previous = selectElement.value;
    selectElement.innerHTML = optionsHtml ?? '';
    this._restoreAgentSelection(selectElement, previous);

    getSelectOptionElements(selectElement).forEach((opt) => {
      this._decorateAgentOption(opt);
    });

    // Update the select's tooltip to show selected agent info
    this._updateAgentSelectTooltip(selectElement);
  }

  /**
   * Update the agent select element's tooltip to show the selected agent's details.
   * This provides immediate feedback about the currently selected agent.
   * @param {HTMLElement} selectElement - The agent select element
   */
  _updateAgentSelectTooltip(selectElement) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }

    const selectedOption = getSelectedOptionElement(selectElement);
    if (selectedOption && selectedOption.title) {
      // Use the selected option's tooltip as the select's tooltip
      selectElement.title = selectedOption.title;
    } else if (selectedOption) {
      // Fallback: show the agent name
      const label =
        selectedOption.dataset?.label || selectedOption.textContent || '';
      selectElement.title = label;
    } else {
      selectElement.title = '';
    }
  }

  _decorateAgentOption(opt) {
    const {
      label,
      isMultiple,
      isToolUse,
      isRemote,
      isCustom,
      description,
      agentType,
    } = this._readAgentOptionMetadata(opt);

    const hints = [];
    let displayLabel = label;

    // Add agent type hint to tooltip (no unicode icon - too confusing)
    if (agentType) {
      const decorator = getAgentTypeDecorator(agentType);
      hints.push(decorator.hint || `Type: ${decorator.label}`);
    }

    // Add cloud icon for remote agents (visible indicator, at end)
    if (isRemote) {
      hints.push(AGENT_DECORATORS.properties.remote.hint);
    }

    // Add custom hint to tooltip (no unicode icon - too confusing)
    if (isCustom) {
      const { hint } = AGENT_DECORATORS.properties.custom;
      hints.push(hint);
    }

    // Add description (primary info about the agent)
    if (description) {
      hints.push(description);
    }

    // Add multiple outputs indicator (visible indicator, at end)
    if (isMultiple) {
      const { unicode, hint } = AGENT_DECORATORS.properties.multipleOutputs;
      displayLabel = `${displayLabel} ${unicode}`;
      hints.push(hint);
      opt.style.opacity = '0.9';
    } else {
      opt.style.opacity = '';
    }

    // Add cloud icon for remote agents (visible indicator, at end after multiple)
    if (isRemote) {
      const { unicode } = AGENT_DECORATORS.properties.remote;
      displayLabel = `${displayLabel} ${unicode}`;
    }

    // Add tool-use hint only if not already covered by agentType
    // (avoid duplicate "Can execute tools and code" when agentType is toolUse)
    if (isToolUse && agentType !== 'toolUse') {
      hints.push('Can execute tools and code');
    }

    // Set text content (vscode-option doesn't support HTML)
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
      isRemote: opt.dataset.remote === 'true',
      isCustom: opt.dataset.custom === 'true',
      description: opt.dataset.description ?? '',
      agentType: opt.dataset.agentType ?? '',
    };
  }

  /**
   * Parse source:name format to extract clean name and source.
   * @param {string} value - The value in source:name format
   * @returns {{source: string, name: string} | null} - Parsed parts or null if invalid
   */
  _parseAgentKey(value) {
    if (!value) return null;
    const colonIdx = value.indexOf(':');
    if (colonIdx === -1) return null;
    return {
      source: value.slice(0, colonIdx),
      name: value.slice(colonIdx + 1),
    };
  }

  /**
   * Sets an agent selector value, creating a placeholder option if needed.
   * Placeholder options display the clean agent name (without source prefix).
   * When SET_AGENT_OPTIONS arrives, it will replace options with properly decorated versions.
   * @param {string} selectId - The ID of the agent select element
   * @param {string} value - The agent value (in source:name format)
   */
  _setAgentValue(selectId, value) {
    if (!value) {
      safeSetElementValue(selectId, value);
      return;
    }

    const selectElement = document.getElementById(selectId);
    if (!selectElement) {
      console.warn(`Agent select element with id '${selectId}' not found`);
      safeSetElementValue(selectId, value);
      return;
    }

    // Check if option already exists
    const existingOption = Array.from(selectElement.children).find(
      (opt) => opt.value === value,
    );

    // If option doesn't exist, create a placeholder with clean display name.
    // SET_AGENT_OPTIONS will replace this with properly decorated options.
    if (!existingOption) {
      const option = document.createElement('vscode-option');
      option.value = value;

      // Extract clean name from source:name format
      const parsed = this._parseAgentKey(value);
      const displayName = parsed ? parsed.name : value;

      option.textContent = displayName;
      option.dataset.label = displayName;

      // Set source-based data attributes for basic styling
      if (parsed) {
        option.dataset.source = parsed.source;
        if (parsed.source === 'remote') {
          option.dataset.remote = 'true';
        } else if (parsed.source === 'custom') {
          option.dataset.custom = 'true';
        }
      }

      selectElement.appendChild(option);
    }

    // Set the value and dispatch change event to update the component's display
    safeSetElementValue(selectId, value);
    selectElement.dispatchEvent(new Event('change'));
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
    return isSelectLikeElement(element) ? element : null;
  }

  _getSessionTypeForSelect(selectElement) {
    if (!selectElement?.id) {
      return null;
    }
    const entry = Object.entries(AGENT_SELECT_IDS).find(
      ([, id]) => id === selectElement.id,
    );
    return entry ? entry[0] : null;
  }

  _getSavedAgentValue(sessionType) {
    const state = mainViewState.get?.() ?? {};
    if (sessionType === SESSION_TYPES.TOOL_USE) {
      return state.toolUseAgent ?? state.agent ?? '';
    }
    if (sessionType === SESSION_TYPES.WORKFLOW) {
      return state.workflowAgent ?? state.agent ?? '';
    }
    return '';
  }

  /**
   * Generic helper to restore a select element's value using a fallback chain.
   * Attempts to restore from a list of candidate values in order, falling back
   * to the first enabled option if no candidate matches.
   *
   * Also handles backwards compatibility for agent values that were saved without
   * the source: prefix (e.g., "summarize" → "custom:summarize").
   *
   * @param {HTMLElement} selectElement - The select element to restore
   * @param {string[]} candidates - Array of candidate values to try, in priority order
   */
  _restoreSelectValue(selectElement, candidates) {
    const filteredCandidates = candidates.filter(Boolean);
    const options = getSelectOptionElements(selectElement);

    // First try exact match
    const exactMatch = filteredCandidates.find((value) =>
      options.some((option) => option.value === value),
    );

    if (exactMatch) {
      selectElement.value = exactMatch;
      return;
    }

    // Migration: try matching by name suffix for old format values
    // (e.g., "summarize" matches "custom:summarize" or "builtin:summarize")
    for (const candidate of filteredCandidates) {
      // Skip if already in source:name format
      if (candidate.includes(':')) continue;

      const suffixMatch = options.find(
        (option) => option.value.endsWith(`:${candidate}`) && !option.disabled,
      );
      if (suffixMatch) {
        selectElement.value = suffixMatch.value;
        return;
      }
    }

    const fallbackOption =
      options.find((option) => !option.disabled) ?? options[0];
    if (fallbackOption) {
      selectElement.value = fallbackOption.value;
    }
  }

  _restoreAgentSelection(selectElement, previousValue) {
    const sessionType = this._getSessionTypeForSelect(selectElement);
    const savedValue = sessionType ? this._getSavedAgentValue(sessionType) : '';
    // Prioritize saved state over previous UI value for agents
    this._restoreSelectValue(selectElement, [savedValue, previousValue]);
  }

  _restoreModelSelection(selectElement, previousValue) {
    const savedValue = mainViewState.get?.()?.model ?? '';
    // Prioritize saved state over previous UI value for consistency
    this._restoreSelectValue(selectElement, [savedValue, previousValue]);
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
    this._setupAgentSelectListeners();
    if (requestData) {
      this._initializeDataRequests();
    }
  }

  /** Setup change listeners for agent selects to update tooltips. */
  _setupAgentSelectListeners() {
    // Clean up any existing listeners first
    this._cleanupTooltipListeners();

    // Update tooltip when agent selection changes
    AGENT_SELECT_LIST.forEach((selectId) => {
      const selectElement = document.getElementById(selectId);
      if (selectElement) {
        const handler = () => this._updateAgentSelectTooltip(selectElement);
        selectElement.addEventListener('change', handler);
        this._tooltipListeners.push({ element: selectElement, handler });
        // Set initial tooltip
        this._updateAgentSelectTooltip(selectElement);
      }
    });
  }

  /** Remove tooltip listeners to prevent memory leaks. */
  _cleanupTooltipListeners() {
    this._tooltipListeners.forEach(({ element, handler }) => {
      element.removeEventListener('change', handler);
    });
    this._tooltipListeners = [];
  }

  cleanup() {
    this._isDisposed = true;
    if (this._disposeModelWaiter) {
      this._disposeModelWaiter();
      this._disposeModelWaiter = null;
    }

    this._cleanupTooltipListeners();
    super.cleanup();
    this._instructionEl = null;
    this._elementCache.clear();
  }

  /* ---------- Private helpers ---------- */
  _setToggleIcon(element, isVisible) {
    if (!element) return;
    setChevronIcon(element, isVisible);
  }

  _registerFileListCallbacks() {
    const updateCommands = {
      input: MAIN_VIEW_COMMANDS.UPDATE_INPUT_FILES,
      reference: MAIN_VIEW_COMMANDS.UPDATE_REFERENCE_FILES,
      auxiliary: MAIN_VIEW_COMMANDS.UPDATE_AUXILIARY_FILES,
      media: MAIN_VIEW_COMMANDS.UPDATE_MEDIA_FILES,
      output: MAIN_VIEW_COMMANDS.UPDATE_OUTPUT_FILES,
    };

    FILE_TYPES.forEach((fileType) => {
      const listId =
        fileType === 'output' ? ELEMENT_IDS.OUTPUT_FILES : `${fileType}Files`;

      fileList.setRemoveCallback(listId, (files) => {
        const command = updateCommands[fileType];
        if (command) {
          vscode.postMessage({ command, files });
        }
        mainViewState.update({ [`${fileType}Files`]: files });
      });
    });
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
    const sessionCategory = state.session?.agentCategory;

    let sessionType = state.sessionType;
    if (sessionCategory === SESSION_TYPES.TOOL_USE) {
      sessionType = SESSION_TYPES.TOOL_USE;
    } else if (sessionCategory === SESSION_TYPES.WORKFLOW) {
      sessionType = SESSION_TYPES.WORKFLOW;
    }

    if (!sessionType) {
      sessionType = state.isToolUseAgent
        ? SESSION_TYPES.TOOL_USE
        : SESSION_TYPES.WORKFLOW;
    }

    const normalizedSessionType = normalizeSessionType(sessionType);
    const isToolUseSession = normalizedSessionType === SESSION_TYPES.TOOL_USE;

    const workflowAgentValue =
      state.workflowAgent ??
      (!isToolUseSession ? state.agent : undefined) ??
      '';
    const toolUseAgentValue =
      state.toolUseAgent ?? (isToolUseSession ? state.agent : undefined) ?? '';

    safeSetElementValue(SESSION_TYPE_INPUT, normalizedSessionType);
    this._setAgentValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      workflowAgentValue,
    );
    this._setAgentValue(
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
      sessionType: normalizedSessionType,
      workflowAgent: workflowAgentValue,
      toolUseAgent: toolUseAgentValue,
      agent:
        state.agent ??
        (isToolUseSession ? toolUseAgentValue : workflowAgentValue),
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

        if (multipleFiles) {
          multipleFiles.innerHTML = '';
        }

        if (filesArray.length > 0 && multipleFiles) {
          fileList._batchMode = true;
          filesArray.forEach((file) => {
            fileList.add(multipleFilesId, file);
          });
          fileList._batchMode = false;
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

      // Hide progress indicator
      const progressContainer = document.getElementById(
        'polishProgressContainer',
      );
      if (progressContainer) {
        progressContainer.style.display = 'none';
      }

      vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
        text: 'Instruction text has been polished!',
      });
      mainViewState.save();
    }
    this._postHandle();
  }

  handleInstructionTextPolishError(message) {
    // Hide progress indicator
    const progressContainer = document.getElementById(
      'polishProgressContainer',
    );
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }

    // Show error message
    vscode.postMessage({
      command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
      text: `Error polishing text: ${message.error || 'Unknown error'}`,
    });
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
    recordingManager.setRecording(false);
    this._postHandle();
  }
}

const handler = new MainViewMessageHandler();
export const setup = handler.setup.bind(handler);
export const cleanup = handler.cleanup.bind(handler);
