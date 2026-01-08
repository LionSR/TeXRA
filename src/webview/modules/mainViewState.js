// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  CHECK_BOXES_TOOL_USE,
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
  AGENT_SELECT_LIST,
  parseSessionType,
  VSCODE_RADIO_GROUP_TAG,
} from './constants.js';
import { fileList } from './uiManagers/FileList.js';
import {
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
  setChevronIcon,
  setElementDisabled,
  isSelectLikeElement,
  getSelectOptionElements,
  setExpandedState,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { WebviewStateManager } from '@common/webviewState.js';

// Note: These defaults must match the values in agentRegistry.ts
const DEFAULT_WORKFLOW_AGENT = 'correct';
const DEFAULT_TOOL_USE_AGENT = 'chat';

function getSessionDefaultAgent(sessionType) {
  return sessionType === SESSION_TYPES.TOOL_USE
    ? DEFAULT_TOOL_USE_AGENT
    : DEFAULT_WORKFLOW_AGENT;
}

function getDefaultState() {
  return {
    sessionType: SESSION_TYPES.WORKFLOW,
    workflowAgent: getSelectDefaultValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      DEFAULT_WORKFLOW_AGENT,
    ),
    toolUseAgent: getSelectDefaultValue(
      AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
      DEFAULT_TOOL_USE_AGENT,
    ),
    model: 'gemini3p',
    commit: 'HEAD',
  };
}

function setFileSelectionGroupDisabled(isDisabled) {
  const container = document.querySelector('.file-selection-group');
  if (!(container instanceof HTMLElement)) {
    return;
  }

  container.classList.toggle('file-selection-group--disabled', isDisabled);
  if (isDisabled) {
    container.setAttribute('aria-disabled', 'true');
  } else {
    container.removeAttribute('aria-disabled');
  }

  const interactiveElements = container.querySelectorAll(
    [
      'select',
      'button',
      'input',
      'vscode-button',
      'vscode-toolbar-button',
      'vscode-single-select',
      'vscode-textarea',
      'vscode-textfield',
      'vscode-checkbox',
      'vscode-radio',
    ].join(', '),
  );
  interactiveElements.forEach((element) => {
    setElementDisabled(element, isDisabled);
  });
}

function getSelectDefaultValue(selectId, fallback) {
  const element = safeGetElementById(selectId);
  if (isSelectLikeElement(element)) {
    if (element.value) {
      return element.value;
    }
    const options = getSelectOptionElements(element);
    const firstValueOption = options.find((option) => option.value);
    if (firstValueOption) {
      return firstValueOption.value;
    }
  }
  return fallback;
}

/**
 * Manages persistent state for the main webview.
 */
export class MainViewState {
  constructor() {
    this.stateManager = new WebviewStateManager();
    // Counter to prevent save() during state restoration or option updates.
    // vscode-single-select fires 'change' events on programmatic value changes,
    // which would trigger save() and capture partial/inconsistent DOM state.
    // Using a counter allows nesting (e.g., option update during restoration).
    this._saveBlockCount = 0;
  }

  /**
   * Block save() calls. Use with unblockSave() in a try/finally pattern.
   * Supports nesting - each blockSave() must have a matching unblockSave().
   */
  blockSave() {
    this._saveBlockCount++;
  }

  /**
   * Unblock save() calls. Must be paired with a prior blockSave().
   */
  unblockSave() {
    if (this._saveBlockCount > 0) {
      this._saveBlockCount--;
    }
  }

  /**
   * Check if save() calls are currently blocked.
   * Useful for change handlers that should not post messages during programmatic updates.
   * @returns {boolean} True if save() calls are blocked
   */
  isBlocked() {
    return this._saveBlockCount > 0;
  }

  get() {
    return this.stateManager.getState();
  }

  set(state) {
    this.stateManager.setState(state);
  }

  update(partial) {
    this.stateManager.update(partial);
  }

  /** Initialize UI with default state */
  setDefaults() {
    this.applySessionType(SESSION_TYPES.WORKFLOW, { skipSave: true });

    const workflowAgentDefault = getSelectDefaultValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      DEFAULT_WORKFLOW_AGENT,
    );
    safeSetElementValue(
      AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
      workflowAgentDefault,
    );

    const toolUseAgentDefault = getSelectDefaultValue(
      AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
      DEFAULT_TOOL_USE_AGENT,
    );
    safeSetElementValue(
      AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
      toolUseAgentDefault,
    );

    MULTIPLE_SELECTIONS.forEach((id) => {
      const toggleId = `toggle${capitalize(id)}`;
      fileList.setVisibility(id, toggleId, false);
      const listDiv = safeGetElementById(id);
      if (listDiv) {
        listDiv.innerHTML = '';
      }
    });

    const latexdiffsContent = safeGetElementById(
      ELEMENT_IDS.LATEXDIFFS_CONTENT,
    );
    const toggleLatexdiffs = safeGetElementById(ELEMENT_IDS.TOGGLE_LATEXDIFFS);
    if (latexdiffsContent && toggleLatexdiffs) {
      latexdiffsContent.style.display = 'none';
      setChevronIcon(toggleLatexdiffs, false);
    }

    this.save();
  }

  /** Restore state from VS Code storage */
  restore() {
    this.blockSave();
    let needsSaveAfter = false;
    try {
      needsSaveAfter = this._restoreImpl();
    } finally {
      this.unblockSave();
    }
    // If setDefaults() was called, its save() was skipped due to blockSave(),
    // so we need to save now after unblockSave()
    if (needsSaveAfter) {
      this.save();
    }
  }

  /**
   * @returns {boolean} true if setDefaults() was called and needs a save after
   */
  _restoreImpl() {
    const previousState = this.stateManager.getState();
    if (previousState) {
      const defaults = getDefaultState();
      const mergedState = { ...defaults, ...previousState };
      const sessionType =
        parseSessionType(mergedState.sessionType) ?? defaults.sessionType;
      mergedState.sessionType = sessionType;

      VALUE_ELEMENTS.forEach((id) => {
        safeSetElementValue(id, mergedState[id] ?? '');
      });

      // Load checkboxes
      CHECK_BOXES.forEach((id) => {
        safeSetElementChecked(id, previousState[id] ?? false);
      });

      // Tool config multi-select is initialized by loadState

      MULTIPLE_SELECTIONS.forEach((id) => {
        const toggleId = `toggle${capitalize(id)}`;
        const selectDiv = safeGetElementById(id);
        if (!selectDiv) {
          console.warn(`Element with id '${id}' not found`);
          return;
        }
        selectDiv.innerHTML = '';

        const filesArray = mergedState[id] ?? [];
        const isVisible = mergedState[`${id}Visible`];

        if (filesArray && filesArray.length > 0) {
          filesArray.forEach((file) => {
            fileList.add(id, file);
          });
          fileList.setVisibility(
            id,
            toggleId,
            isVisible !== undefined ? isVisible : true,
          );
        } else {
          fileList.setVisibility(id, toggleId, false);
        }
      });

      const latexdiffsContent = safeGetElementById(
        ELEMENT_IDS.LATEXDIFFS_CONTENT,
      );
      const toggleLatexdiffs = safeGetElementById(
        ELEMENT_IDS.TOGGLE_LATEXDIFFS,
      );
      if (latexdiffsContent && toggleLatexdiffs) {
        const visible = mergedState.latexdiffsVisible ?? false;
        latexdiffsContent.style.display = visible ? 'block' : 'none';
        setChevronIcon(toggleLatexdiffs, visible);
        setExpandedState(latexdiffsContent, '.latexdiffs-section', visible);
      }

      this.applySessionType(sessionType, { skipSave: true });
      fileList.hideEmpty(MULTIPLE_SELECTIONS);
      return false; // No save needed - state already exists
    } else {
      this.setDefaults();
      fileList.hideEmpty(MULTIPLE_SELECTIONS);
      return true; // setDefaults() save was skipped, needs save after
    }
  }

  /** Persist current UI state */
  save() {
    if (this._saveBlockCount > 0) {
      return;
    }

    const state = {
      latexdiffsVisible:
        safeGetElementById(ELEMENT_IDS.LATEXDIFFS_CONTENT)?.style.display ===
        'block',
    };

    VALUE_ELEMENTS.forEach((id) => {
      const value = safeGetElementValue(id);
      if (value !== undefined) {
        state[id] = value;
      }
    });

    // Save checkboxes
    CHECK_BOXES.forEach((id) => {
      state[id] = safeGetElementChecked(id);
    });

    MULTIPLE_SELECTIONS.forEach((id) => {
      const elementDiv = safeGetElementById(id);
      if (!elementDiv) return;
      const containerDiv = safeGetElementById(`${id}Container`);
      state[`${id}Visible`] =
        containerDiv && containerDiv.style.display === 'block';
      state[id] = fileList.getSelected(elementDiv);
    });

    state.outputFilesActive = this._isOutputFilesActive();

    const sessionTypeValue =
      state.sessionType ?? safeGetElementValue(SESSION_TYPE_INPUT);
    const resolvedSessionType =
      parseSessionType(sessionTypeValue) ?? SESSION_TYPES.WORKFLOW;
    const activeSelectId = AGENT_SELECT_IDS[resolvedSessionType];
    if (activeSelectId) {
      const agentValue = safeGetElementValue(activeSelectId) ?? '';
      // Save the actual DOM value, not a computed default.
      // DOM modification during save() can trigger unexpected change events.
      // If agent is empty, restore() or applySessionType() will handle defaults.
      state.agent = agentValue;
      state.isToolUseAgent = resolvedSessionType === SESSION_TYPES.TOOL_USE;
    }

    this.stateManager.setState(state);
  }

  applySessionType(sessionType, options = {}) {
    const { skipSave = false } = options;
    const resolvedSessionType =
      parseSessionType(sessionType) ?? SESSION_TYPES.WORKFLOW;
    const isToolUseSession = resolvedSessionType === SESSION_TYPES.TOOL_USE;

    const sessionInput = safeGetElementById(SESSION_TYPE_INPUT);
    if (sessionInput) {
      sessionInput.value = resolvedSessionType;
    }

    const toggleContainer = safeGetElementById(ELEMENT_IDS.SESSION_TYPE_TOGGLE);
    if (toggleContainer) {
      const radioGroup =
        toggleContainer.tagName === VSCODE_RADIO_GROUP_TAG
          ? toggleContainer
          : toggleContainer.querySelector('vscode-radio-group');
      if (radioGroup instanceof HTMLElement) {
        const radios = radioGroup.querySelectorAll('vscode-radio');
        radios.forEach((radio) => {
          if (!(radio instanceof HTMLElement)) {
            return;
          }
          const radioValue =
            radio.dataset.sessionType || radio.getAttribute('value');
          const isActive = radioValue === resolvedSessionType;
          if ('checked' in radio) {
            radio.checked = isActive;
          }
          if (isActive) {
            radio.setAttribute('checked', '');
            radio.setAttribute('aria-checked', 'true');
          } else {
            radio.removeAttribute('checked');
            radio.setAttribute('aria-checked', 'false');
          }
        });
      } else {
        const buttons = toggleContainer.querySelectorAll('[data-session-type]');
        buttons.forEach((button) => {
          if (!(button instanceof HTMLElement)) {
            return;
          }
          const isActive = button.dataset.sessionType === resolvedSessionType;
          button.classList.toggle('active', isActive);
          button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
      }
    }

    AGENT_SELECT_LIST.forEach((selectId) => {
      const selectEl = safeGetElementById(selectId);
      if (!selectEl) {
        return;
      }
      const isActive = selectId === AGENT_SELECT_IDS[resolvedSessionType];
      selectEl.classList.toggle('agent-select--active', isActive);
      selectEl.classList.toggle('agent-select--hidden', !isActive);
      selectEl.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      selectEl.tabIndex = isActive ? 0 : -1;
      if (isActive && !selectEl.value) {
        // Check stored state first - DOM might not be updated yet for custom elements
        // (vscode-single-select may not synchronously update .value)
        const storedState = this.stateManager.getState() || {};
        const stateKey =
          resolvedSessionType === SESSION_TYPES.TOOL_USE
            ? 'toolUseAgent'
            : 'workflowAgent';
        const storedValue = storedState[stateKey];

        if (storedValue) {
          // DOM is stale but we have a stored value - use it
          safeSetElementValue(selectId, storedValue);
        } else {
          // Truly empty - apply default
          const fallback = getSelectDefaultValue(
            selectId,
            getSessionDefaultAgent(resolvedSessionType),
          );
          safeSetElementValue(selectId, fallback);
        }
      }
    });

    setFileSelectionGroupDisabled(isToolUseSession);

    // Disable Tool Config checkboxes for tool use sessions
    CHECK_BOXES_TOOL_USE.forEach((id) => {
      const checkbox = safeGetElementById(id);
      if (checkbox instanceof HTMLElement) {
        checkbox.disabled = isToolUseSession;
      }
    });

    if (isToolUseSession) {
      this._resetOutputFilesForToolUse();
    }

    if (!skipSave) {
      this.save();
    }
  }

  _getOutputFilesContainer() {
    return safeGetElementById(ELEMENT_IDS.OUTPUT_FILES_CONTAINER);
  }

  _setOutputFilesContainerVisible(visible) {
    const container = this._getOutputFilesContainer();
    if (container) {
      container.style.display = visible ? 'block' : 'none';
    }
  }

  _isOutputFilesActive() {
    const container = this._getOutputFilesContainer();
    return Boolean(container && container.style.display === 'block');
  }

  _resetOutputFilesForToolUse() {
    const wasActive = this._isOutputFilesActive();
    if (wasActive) {
      fileList.empty(
        ELEMENT_IDS.OUTPUT_FILES,
        ELEMENT_IDS.TOGGLE_OUTPUT_FILES,
        false,
      );

      this._setOutputFilesContainerVisible(false);
    }

    this.update({
      outputFiles: [],
      outputFilesVisible: false,
      outputFilesActive: false,
    });
  }
}

export const mainViewState = new MainViewState();
fileList.setSaveFn(() => mainViewState.save());
