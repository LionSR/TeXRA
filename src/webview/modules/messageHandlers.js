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
  CHECK_BOXES,
} from './constants.js';
import { webviewEventBus } from './eventBus.js';
import { createFileHandlers } from './handlers/fileHandlers.js';
import { createRecordingHandlers } from './handlers/recordingHandlers.js';
import { recordingManager } from './domHandlers.js';
import { collectCurrentContext } from './state/currentContext.js';

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
  safeSetElementChecked,
  safeGetElementById,
  safeGetElementValue,
  setChevronIcon,
  waitForElement,
  isSelectLikeElement,
  getSelectOptionElements,
  getSelectedOptionElement,
} from '@common/domUtils.js';
import { capitalize, uncapitalize } from '@common/stringUtils.js';
import {
  AGENT_DECORATORS,
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
      [MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER]: () =>
        bannerManager.showBanner(ELEMENT_IDS.GETTING_STARTED_BANNER),
      [MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER]: () =>
        bannerManager.hideBanner(ELEMENT_IDS.GETTING_STARTED_BANNER),
      [MAIN_VIEW_COMMANDS.SHOW_LOGIN_BANNER]: (m) =>
        bannerManager.showBanner(ELEMENT_IDS.LOGIN_BANNER, m),
      [MAIN_VIEW_COMMANDS.HIDE_LOGIN_BANNER]: () =>
        bannerManager.hideBanner(ELEMENT_IDS.LOGIN_BANNER),
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

        // Block saves for entire operation to prevent race conditions between
        // await completing and _applyModelOptions starting
        mainViewState.blockSave();
        try {
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
        } finally {
          mainViewState.unblockSave();
        }
      },
      /**
       * Handles SET_AGENT_OPTIONS command to update agent dropdowns.
       *
       * Like SET_MODEL_OPTIONS, waits for select elements to appear before applying.
       * Uses a disposer pattern to handle race conditions when multiple messages
       * arrive before elements are ready. Aborts entirely if superseded to prevent
       * stale data from overwriting newer options.
       */
      [MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS]: async (m) => {
        const optionsPayload = m.options ?? {};
        const configs = [
          {
            id: AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
            html: optionsPayload.workflow ?? '',
          },
          {
            id: AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
            html: optionsPayload.toolUse ?? '',
          },
        ];

        // Block saves for entire operation to prevent race conditions between
        // await completing and _applyAgentOptions starting
        mainViewState.blockSave();
        try {
          let applied = false;

          for (const { id, html } of configs) {
            if (!id) continue;

            let select = document.getElementById(id);
            if (!isSelectLikeElement(select)) {
              // Wait for element to appear, similar to SET_MODEL_OPTIONS
              const waitHandle = waitForElement(`#${id}`);

              // Cancel any previous waiter for this element
              const waiterKey = `_disposeAgentWaiter_${id}`;
              if (this[waiterKey]) {
                this[waiterKey]();
              }

              const disposeHandle = () => {
                waitHandle.dispose();
                if (this[waiterKey] === disposeHandle) {
                  this[waiterKey] = null;
                }
              };
              this[waiterKey] = disposeHandle;

              select = await waitHandle.promise;

              // Check if superseded or disposed - abort entirely to prevent
              // stale data from this message overwriting newer options
              if (this[waiterKey] !== disposeHandle || this._isDisposed) {
                return;
              }
              this[waiterKey] = null;

              if (!isSelectLikeElement(select)) {
                console.warn(
                  `SET_AGENT_OPTIONS: Agent select '${id}' not found after waiting`,
                );
                continue;
              }
            }

            this._applyAgentOptions(select, html);
            applied = true;
          }

          if (!applied) {
            console.warn('SET_AGENT_OPTIONS: No agent select elements found');
          }
        } finally {
          mainViewState.unblockSave();
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
        const options = getSelectOptionElements(selectElement);

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

        // Guard against save() during this operation. _setAgentValue dispatches
        // a change event which triggers save(). If model options haven't loaded
        // yet, save() would read incorrect values and corrupt the state.
        // We use update() below which bypasses save() and persists directly.
        mainViewState.blockSave();
        try {
          // Set the value FIRST (creates placeholder if no match)
          // This must happen before applySessionType to prevent default override
          this._setAgentValue(selectId, targetValue);

          // Update mainViewState to persist the selection
          // update() bypasses save() and persists directly via setState()
          const stateKey =
            targetSessionType === SESSION_TYPES.TOOL_USE
              ? 'toolUseAgent'
              : 'workflowAgent';
          mainViewState.update({ [stateKey]: targetValue });

          // NOW switch session type UI (shows correct dropdown, updates radio buttons)
          // Pass skipSave: true since we already updated state via mainViewState.update()
          // This prevents save() from reading stale DOM values for custom elements
          mainViewState.applySessionType(targetSessionType, { skipSave: true });

          // Decorate the placeholder option if it was just created
          // Re-query options since _setAgentValue may have added a new option
          const currentOptions = getSelectOptionElements(selectElement);
          const option = currentOptions.find(
            (opt) => opt.value === targetValue,
          );
          if (option && !option.dataset.decorated) {
            this._decorateAgentOption(option);
            option.dataset.decorated = 'true';
          }

          // Update the select's tooltip
          this._updateAgentSelectTooltip(selectElement);
        } finally {
          mainViewState.unblockSave();
        }
      },
    };
  }

  _createStateHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.STATE_RESTORE]: this.handleRestoreState.bind(this),
      [MAIN_VIEW_COMMANDS.CHECK_RESTORED_BASE_FILE]:
        this.handleCheckRestoredBaseFile.bind(this),
    };
  }

  _createInstructionHandlers() {
    return {
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISHED]:
        this.handleInstructionTextPolished.bind(this),
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_POLISH_ERROR]:
        this.handleInstructionTextPolishError.bind(this),
      [MAIN_VIEW_COMMANDS.INSTRUCTION_TEXT_TRANSCRIBED]:
        this.handleInstructionTextTranscribed.bind(this),
    };
  }

  _applyModelOptions(selectElement, optionsHtml) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }
    // Caller must wrap in blockSave()/unblockSave() - vscode-single-select
    // fires change events during innerHTML replacement which would trigger save()
    const previous = selectElement.value;

    // Two-phase selection restoration:
    // 1. _markOptionAsSelected: Add 'selected' attribute to HTML BEFORE innerHTML assignment.
    //    This prevents vscode-single-select's slotchange from defaulting to first option.
    // 2. _restoreModelSelection: Handles fallback cases after innerHTML is set:
    //    - Value not found in options (preserves user preference in state)
    //    - Sets selectElement.value for programmatic access
    //    Both are needed because slotchange fires asynchronously after innerHTML.
    const htmlWithSelected = this._markOptionAsSelected(optionsHtml, previous);
    selectElement.innerHTML = htmlWithSelected;
    this._restoreModelSelection(selectElement, previous);

    getSelectOptionElements(selectElement).forEach((opt) => {
      this._decorateModelOption(opt);
    });
    updateModelApiKeyBanner(selectElement);
  }

  _decorateModelOption(opt) {
    const { provider, context, cost, requiresKey } = opt.dataset;
    const modelName =
      opt.textContent?.trim() ?? opt.getAttribute('value') ?? '';

    // Get provider decorator for the icon
    const decorator = getModelProviderDecorator(provider);

    // Build tooltip with provider info
    const hints = [];
    hints.push(`${decorator.label}`);
    if (context) hints.push(`Context: ${context}`);
    if (cost) hints.push(`Cost: ${cost}`);

    // Set content with provider icon, adding red ✗ via DOM if key is missing
    opt.textContent = `${decorator.unicode} ${modelName}`;
    if (requiresKey === 'true') {
      const span = document.createElement('span');
      span.className = 'api-key-missing';
      span.textContent = ' ✗';
      opt.appendChild(span);
    }

    if (hints.length > 0) {
      opt.title = hints.join(' | ');
      opt.setAttribute('aria-label', `${modelName} (${hints.join(', ')})`);
    }
  }

  _applyAgentOptions(selectElement, optionsHtml) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }
    // Caller must wrap in blockSave()/unblockSave() - vscode-single-select
    // fires change events during innerHTML replacement which would trigger save()
    const previous = selectElement.value;

    // Two-phase selection restoration (see _applyModelOptions for details):
    // 1. _markOptionAsSelected: Prevents slotchange from defaulting to first option
    // 2. _restoreAgentSelection: Handles fallbacks (value migration, placeholder creation)
    const htmlWithSelected = this._markOptionAsSelected(
      optionsHtml ?? '',
      previous,
    );
    selectElement.innerHTML = htmlWithSelected;
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
    const { label, isMultiple, isToolUse, isRemote, isCustom, description } =
      this._readAgentOptionMetadata(opt);

    const hints = [];
    let displayLabel = label;

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

    // Add tool-use hint
    if (isToolUse) {
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
    // Extract label with fallback chain: dataset.label > textContent > value attribute
    const label =
      opt.dataset.label ||
      opt.textContent?.trim() ||
      opt.getAttribute('value') ||
      '';
    if (label && !opt.dataset.label) {
      opt.dataset.label = label;
    }

    const { dataset } = opt;
    return {
      label,
      isMultiple: dataset.multiple === 'true',
      isToolUse: dataset.toolUse === 'true',
      isRemote: dataset.remote === 'true',
      isCustom: dataset.custom === 'true',
      description: dataset.description ?? '',
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

    // Clear 'selected' attribute from all existing options first.
    // vscode-single-select reads the 'selected' property during slotchange.
    Array.from(selectElement.children).forEach((opt) => {
      opt.removeAttribute('selected');
      if ('selected' in opt) {
        opt.selected = false;
      }
    });

    // Determine the target option - either existing or newly created
    let targetOption = existingOption;

    // If option doesn't exist, create a placeholder with clean display name.
    // SET_AGENT_OPTIONS will replace this with properly decorated options.
    if (!targetOption) {
      targetOption = document.createElement('vscode-option');
      targetOption.value = value;

      // Extract clean name from source:name format
      const parsed = this._parseAgentKey(value);
      const displayName = parsed ? parsed.name : value;

      targetOption.textContent = displayName;
      targetOption.dataset.label = displayName;

      // Set source-based data attributes for basic styling
      if (parsed) {
        targetOption.dataset.source = parsed.source;
        if (parsed.source === 'remote') {
          targetOption.dataset.remote = 'true';
        } else if (parsed.source === 'custom') {
          targetOption.dataset.custom = 'true';
        }
      }

      // Mark as selected BEFORE appending so slotchange picks it up
      targetOption.setAttribute('selected', '');
      targetOption.selected = true;

      selectElement.appendChild(targetOption);
    } else {
      // For existing options, set selected attribute
      targetOption.setAttribute('selected', '');
      if ('selected' in targetOption) {
        targetOption.selected = true;
      }
    }

    // For existing options, setting .selected doesn't update the parent component
    // (slotchange only fires when options are added/removed). We must also set .value.
    selectElement.value = value;
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
    return entry?.[0] ?? null;
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
   * @returns {{ matched: boolean, matchedCandidate: string|null, domValue: string }}
   *   - matched: true if a candidate was found in options
   *   - matchedCandidate: the original candidate that was matched (null if fallback used)
   *   - domValue: the final DOM value (may differ from candidate if migrated)
   */
  _restoreSelectValue(selectElement, candidates) {
    const filteredCandidates = candidates.filter(Boolean);
    const options = getSelectOptionElements(selectElement);

    // First try exact match
    for (const candidate of filteredCandidates) {
      const exactMatch = options.find((option) => option.value === candidate);
      if (exactMatch) {
        selectElement.value = candidate;
        return {
          matched: true,
          matchedCandidate: candidate,
          domValue: candidate,
        };
      }
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
        return {
          matched: true,
          matchedCandidate: candidate,
          domValue: suffixMatch.value,
        };
      }
    }

    // Fallback to first enabled option
    const fallbackOption =
      options.find((option) => !option.disabled) ?? options[0];
    const fallbackValue = fallbackOption?.value ?? '';
    if (fallbackValue) {
      selectElement.value = fallbackValue;
    }
    return { matched: false, matchedCandidate: null, domValue: fallbackValue };
  }

  _restoreAgentSelection(selectElement, previousValue) {
    const sessionType = this._getSessionTypeForSelect(selectElement);
    if (!sessionType) {
      // Unknown select element - can't determine which state key to use.
      // Skip restoration to avoid DOM/state mismatch.
      console.warn(
        '_restoreAgentSelection: Unknown select element, skipping restoration',
      );
      return;
    }

    const stateKey =
      sessionType === SESSION_TYPES.TOOL_USE ? 'toolUseAgent' : 'workflowAgent';
    const savedValue = this._getSavedAgentValue(sessionType);

    // Prioritize saved state over previous UI value for agents
    const { matched, matchedCandidate, domValue } = this._restoreSelectValue(
      selectElement,
      [savedValue, previousValue],
    );

    if (!matched) {
      // Restoration failed - recreate placeholder to preserve the agent selection
      // even when the agent isn't in the options (e.g., remote agent from another
      // session, custom agent that was deleted).
      const valueToRestore = savedValue || previousValue;
      if (valueToRestore) {
        this._setAgentValue(selectElement.id, valueToRestore);
        // Update state since _setAgentValue triggers a change event but save() is blocked
        mainViewState.update({ [stateKey]: valueToRestore });
      }
    } else if (matchedCandidate === savedValue) {
      // savedValue was matched (exact or migrated) - update state if DOM value changed
      if (domValue !== savedValue) {
        // Migration occurred - persist the new format
        mainViewState.update({ [stateKey]: domValue });
      }
      // else: exact match, state already correct
    }
    // else: previousValue was matched - keep savedValue in state (user's preference preserved)
  }

  _restoreModelSelection(selectElement, previousValue) {
    const savedValue = mainViewState.get?.()?.model ?? '';
    // Prioritize saved state over previous UI value for consistency
    const { matched } = this._restoreSelectValue(selectElement, [
      savedValue,
      previousValue,
    ]);

    if (!matched) {
      // Restoration failed - preserve the best available value in state.
      // The DOM shows the fallback, but state keeps the user's preference.
      const valueToPreserve = savedValue || previousValue;
      if (valueToPreserve) {
        mainViewState.update({ model: valueToPreserve });
      }
    }
    // Note: Models don't have migration (no source:name format).
    // If matchedCandidate !== savedValue, previousValue was used.
    // Keep savedValue in state - user's preference is preserved for when
    // the model becomes available again (e.g., API key re-added).
  }

  /**
   * Mark an option as selected in HTML string by adding the 'selected' attribute.
   *
   * This is necessary to work around a timing issue in vscode-single-select:
   * When innerHTML is replaced, slotchange fires asynchronously. The component's
   * _setStateFromSlottedElements() reads el.selected from each option, and if none
   * are selected, it defaults to index 0. By the time we set selectElement.value,
   * the slotchange handler has already run and reset the selection.
   *
   * By adding 'selected' attribute to the correct option in HTML before setting
   * innerHTML, slotchange will read selected=true and preserve the selection.
   *
   * Uses DOMParser for safe, encoding-aware HTML manipulation instead of regex.
   *
   * @param {string} html - The options HTML string
   * @param {string} value - The value to mark as selected
   * @returns {string} The HTML with 'selected' attribute added to matching option
   */
  _markOptionAsSelected(html, value) {
    if (!value || !html) {
      return html || '';
    }

    // Use DOMParser for safe, encoding-aware manipulation
    const parser = new DOMParser();
    const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
    const options = doc.querySelectorAll('vscode-option');

    let found = false;
    options.forEach((opt) => {
      // getAttribute returns decoded value, so we compare directly with value
      if (opt.getAttribute('value') === value) {
        opt.setAttribute('selected', '');
        found = true;
      }
    });

    if (!found) {
      // Value not found in options - return original HTML
      return html;
    }

    // Return the modified HTML (with null-safety fallback)
    return doc.querySelector('div')?.innerHTML ?? html;
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
    // Clean up any pending agent waiters from previous setup
    this._cleanupAgentWaiters();
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

  /** Clean up any pending agent waiters to prevent dangling MutationObservers. */
  _cleanupAgentWaiters() {
    for (const id of Object.values(AGENT_SELECT_IDS)) {
      const waiterKey = `_disposeAgentWaiter_${id}`;
      this[waiterKey]?.();
      this[waiterKey] = null;
    }
  }

  dispose() {
    this._isDisposed = true;
    this._disposeModelWaiter?.();
    this._disposeModelWaiter = null;
    this._cleanupAgentWaiters();
    this._cleanupTooltipListeners();
    super.dispose();
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

  /**
   * Restore the main view state from a TaskState object.
   *
   * Flow:
   * 1. Extract session type from canonical session descriptor
   * 2. Set all form field values directly in DOM
   * 3. Set file arrays in DOM
   * 4. Store state for persistence
   * 5. Apply session type UI changes (visibility, disabled states)
   *
   * Note: We intentionally do NOT call mainViewState.restore() here because
   * we already set all DOM values directly. Calling restore() would redundantly
   * re-read state and re-apply to DOM, plus clear and rebuild file lists twice.
   */
  _handleStateRestoration(state) {
    const config = state.agentConfig || state;
    const activeFiles = state.activeFiles ?? {};

    // Block saves during restoration - _setAgentValue dispatches change events
    // which trigger save(), and we don't want to capture incomplete DOM state
    mainViewState.blockSave();
    try {
      const savedState = {};
      const sessionType = this._restoreFormFields(config, savedState);
      this._restoreFileArrays(config, savedState, activeFiles);

      // Store state for persistence and future restoration
      mainViewState.set(savedState);

      // Apply session type UI changes (visibility, disabled states) without re-setting values.
      // skipSave: true because we already have the correct state stored above.
      mainViewState.applySessionType(sessionType, { skipSave: true });
    } finally {
      mainViewState.unblockSave();
    }

    // Prevent _postHandle from calling mainViewState.restore()
    this._skipNextRestoreState = true;
  }

  /**
   * Determine session type from state, with clear priority order.
   * @param {Object} state - AgentConfig or state object
   * @returns {'workflow' | 'toolUse'} The normalized session type
   */
  _determineSessionType(state) {
    const isValidSessionType = (value) =>
      value === SESSION_TYPES.TOOL_USE || value === SESSION_TYPES.WORKFLOW;

    // Priority order: agentCategory > sessionType > legacy flag > default
    // agentCategory is now at top level of AgentConfig
    const candidates = [state.agentCategory, state.sessionType];

    for (const candidate of candidates) {
      if (isValidSessionType(candidate)) {
        return candidate;
      }
    }

    // Legacy: check isToolUseAgent flag
    if (state.isToolUseAgent) {
      return SESSION_TYPES.TOOL_USE;
    }

    return SESSION_TYPES.WORKFLOW;
  }

  /**
   * Extract agent value for a session type from state.
   * AgentConfig stores a single 'agent' field, but webview state may have
   * separate workflowAgent/toolUseAgent fields for UI persistence.
   */
  _extractAgentValue(state, forToolUse, isCurrentlyToolUse) {
    // Prefer explicit session-specific value (nullish check preserves empty string)
    const explicitValue = forToolUse ? state.toolUseAgent : state.workflowAgent;
    if (explicitValue != null) {
      return explicitValue;
    }

    // Use generic 'agent' only when it matches current session type
    const shouldUseGenericAgent =
      state.agent != null && forToolUse === isCurrentlyToolUse;
    return shouldUseGenericAgent ? state.agent : '';
  }

  /**
   * Restore form field values from state to DOM.
   * @returns {string} The normalized session type
   */
  _restoreFormFields(state, savedState) {
    const sessionType = this._determineSessionType(state);
    const isToolUseSession = sessionType === SESSION_TYPES.TOOL_USE;

    // Extract agent values with clear logic
    const workflowAgentValue = this._extractAgentValue(
      state,
      false,
      isToolUseSession,
    );
    const toolUseAgentValue = this._extractAgentValue(
      state,
      true,
      isToolUseSession,
    );

    // Set DOM values
    safeSetElementValue(SESSION_TYPE_INPUT, sessionType);
    this._setAgentValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      workflowAgentValue,
    );
    this._setAgentValue(
      AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
      toolUseAgentValue,
    );

    if (state.model) {
      safeSetElementValue('model', state.model);
    }

    const instructionContent = state.instruction || '';
    const instruction =
      this._instructionEl ||
      (this._instructionEl = this._getElement('instruction'));
    if (instruction) {
      instruction.value = instructionContent;
      instruction.dispatchEvent(new Event('input'));
    }

    // Set single file selections (explicitly clear to '' if not in state)
    safeSetElementValue(INPUT_FILE, state.inputFile || '');
    safeSetElementValue(REFERENCE_FILE, state.referenceFile || '');
    safeSetElementValue(AUXILIARY_FILE, state.auxiliaryFile || '');
    safeSetElementValue(MEDIA_FILE, state.mediaFile || '');

    // Restore checkbox values
    const toolConfig = state.toolConfig ?? {};
    CHECK_BOXES.forEach((id) => {
      const value = state[id] ?? toolConfig[id] ?? false;
      safeSetElementChecked(id, value);
    });

    // Build savedState object for persistence
    Object.assign(savedState, {
      sessionType,
      workflowAgent: workflowAgentValue,
      toolUseAgent: toolUseAgentValue,
      agent:
        state.agent ||
        (isToolUseSession ? toolUseAgentValue : workflowAgentValue),
      model: state.model,
      instruction: instructionContent,
      inputFile: state.inputFile || '',
      referenceFile: state.referenceFile || '',
      auxiliaryFile: state.auxiliaryFile || '',
      mediaFile: state.mediaFile || '',
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

    return sessionType;
  }

  _restoreFileArrays(state, savedState, activeFiles = {}) {
    for (const fileType of FILE_TYPES) {
      const { files, isVisible } = this._getFileArrayState(
        state,
        activeFiles,
        fileType,
      );

      // Update savedState
      savedState[`${fileType}Files`] = files;
      savedState[`${fileType}FilesActive`] = isVisible;

      // Update DOM
      this._updateFileArrayDOM(fileType, files, isVisible);
    }
  }

  /**
   * Extract file array and visibility state for a file type.
   */
  _getFileArrayState(state, activeFiles, fileType) {
    const capitalizedType = capitalize(fileType);
    const files =
      state[`${fileType}Files`] ||
      state[`multiple${capitalizedType}Files`] ||
      [];
    const isVisible =
      activeFiles[fileType] ||
      state[`${fileType}FilesActive`] ||
      state[`multiple${capitalizedType}FilesActive`] ||
      false;
    return { files, isVisible };
  }

  /**
   * Update DOM elements for a file array.
   */
  _updateFileArrayDOM(fileType, files, isVisible) {
    const listId = `${fileType}Files`;
    const containerId = `${fileType}FilesContainer`;
    const toggleId = `toggle${capitalize(fileType)}Files`;

    const listElement = this._getElement(listId);
    const container = this._getElement(containerId);

    // Clear existing content
    if (listElement) {
      listElement.innerHTML = '';
    }

    // Set visibility
    if (container) {
      container.style.display = isVisible ? 'block' : 'none';
    }
    this._setToggleIcon(this._getElement(toggleId), isVisible);

    // Populate files in batch mode
    if (files.length > 0 && listElement) {
      fileList._batchMode = true;
      files.forEach((file) => fileList.add(listId, file));
      fileList._batchMode = false;
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
    try {
      // Check for explicit reset flag from mainView.reset command
      if (message.isResetOperation === true) {
        // Delegate to mainViewState for mode-specific clearing
        // Preserves current radio selection (session type)
        const sessionType = this._getSessionTypeValue();
        mainViewState.clearForNewSession(sessionType);
        // Skip restore in _postHandle since we already persisted the cleared state
        this._skipNextRestoreState = true;
      } else {
        this._handleStateRestoration(message.state);
      }
      this._postHandle();

      // Support executeImmediately for followup tasks (reuses restore flow)
      if (message.executeImmediately) {
        // Determine mode from session type
        const sessionType = this._getSessionTypeValue();
        const mode =
          sessionType === SESSION_TYPES.TOOL_USE ? 'chat' : 'workflow';
        this._executeFollowupTask(mode);
      }
    } catch (error) {
      console.error('Failed to restore state:', error);
      // Show error to user via status or notification
      this._showError?.('Failed to restore state. Please try again.');
    }
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
      this._hidePolishProgress();
      this._showInfo('Instruction text has been polished!');
      mainViewState.save();
    }
    this._postHandle();
  }

  handleInstructionTextPolishError(message) {
    this._hidePolishProgress();
    this._showInfo(`Error polishing text: ${message.error || 'Unknown error'}`);
    this._postHandle();
  }

  _hidePolishProgress() {
    const progressContainer = document.getElementById(
      'polishProgressContainer',
    );
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
  }

  _showInfo(text) {
    vscode.postMessage({
      command: MAIN_VIEW_COMMANDS.SHOW_INFORMATION_MESSAGE,
      text,
    });
  }

  handleInstructionTextTranscribed(message) {
    const instruction = this._getElement('instruction');
    if (instruction && message.text) {
      const startPos = instruction.selectionStart;
      const endPos = instruction.selectionEnd;
      instruction.value =
        instruction.value.substring(0, startPos) +
        message.text +
        instruction.value.substring(endPos);
      instruction.setSelectionRange(
        startPos + message.text.length,
        startPos + message.text.length,
      );
      instruction.focus();
      this._showInfo('Instruction text transcribed!');
      mainViewState.save();
    }
    recordingManager.setRecording(false);
    this._postHandle();
  }

  /**
   * Execute the followup task after setup is complete.
   * Called when executeImmediately flag is set.
   * Note: merge mode is handled directly in ProgressViewMessageHandler.executeMergeDirectly
   * @param {'chat'|'workflow'} mode - The followup mode
   */
  _executeFollowupTask(mode) {
    const {
      agent,
      isToolUseAgent,
      singleFileSelections,
      multipleFileSelections,
      checkboxValues,
    } = collectCurrentContext({ fileList });
    const modelValue = safeGetElementValue('model');
    const instructionValue = safeGetElementValue(ELEMENT_IDS.INSTRUCTION);

    vscode.postMessage({
      command: MAIN_VIEW_COMMANDS.EXECUTE,
      agent,
      model: modelValue,
      instruction: instructionValue,
      isToolUseAgent,
      ...singleFileSelections,
      ...multipleFileSelections,
      ...checkboxValues,
    });
  }
}

const handler = new MainViewMessageHandler();
export const setup = handler.setup.bind(handler);
export const dispose = handler.dispose.bind(handler);
