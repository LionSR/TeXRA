// Local imports - webview
import {
  MULTIPLE_SELECTIONS,
  CHECK_BOXES,
  VALUE_ELEMENTS,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES_AUTO_EXTRACT,
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
  AGENT_SELECT_LIST,
} from './constants.js';
import { fileList } from './uiManagers/FileList.js';
import {
  safeGetElementValue,
  safeGetElementById,
  safeGetElementChecked,
  safeSetElementValue,
  safeSetElementChecked,
  setChevronIcon,
  isSelectLikeElement,
  getSelectOptionElements,
} from '@common/domUtils.js';
import { capitalize } from '@common/stringUtils.js';
import { CHEVRON_DOWN_CLASS } from '@common/iconConstants.js';
import { WebviewStateManager } from '@common/webviewState.js';

const DEFAULT_WORKFLOW_AGENT = 'correct';
const DEFAULT_TOOL_USE_AGENT = 'chat';

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
    'select, button, input, vscode-button, vscode-single-select, vscode-textarea',
  );
  interactiveElements.forEach((element) => {
    if (element instanceof HTMLElement && 'disabled' in element) {
      element.disabled = isDisabled;
    }
  });
}

function getSelectDefaultValue(selectId, fallback) {
  const element = safeGetElementById(selectId);
  if (isSelectLikeElement(element)) {
    if (element.value) {
      return element.value;
    }
    const options = getSelectOptionElements(element);
    if (options.length > 0) {
      return options[0].value ?? '';
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

    const autoExtractToggle = safeGetElementById(
      ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
    );
    const autoExtractOptions = safeGetElementById(
      ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
    );
    if (autoExtractToggle && autoExtractOptions) {
      autoExtractToggle.classList.remove('active');
      autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
      autoExtractOptions.style.display = 'none';
    }

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
    const previousState = this.stateManager.getState();
    if (previousState) {
      const defaults = {
        sessionType: SESSION_TYPES.WORKFLOW,
        workflowAgent: getSelectDefaultValue(
          AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW],
          DEFAULT_WORKFLOW_AGENT,
        ),
        toolUseAgent: getSelectDefaultValue(
          AGENT_SELECT_IDS[SESSION_TYPES.TOOL_USE],
          DEFAULT_TOOL_USE_AGENT,
        ),
        model: 'gemini25p',
        commit: 'HEAD',
      };

      const legacyAgent = previousState.agent;
      const legacyToolUse = previousState.isToolUseAgent === true;
      const normalizedValues = {
        sessionType: previousState.sessionType
          ? previousState.sessionType
          : legacyToolUse
            ? SESSION_TYPES.TOOL_USE
            : defaults.sessionType,
        workflowAgent:
          previousState.workflowAgent ??
          (!legacyToolUse ? legacyAgent : undefined) ??
          defaults.workflowAgent,
        toolUseAgent:
          previousState.toolUseAgent ??
          (legacyToolUse ? legacyAgent : undefined) ??
          defaults.toolUseAgent,
      };

      VALUE_ELEMENTS.forEach((id) => {
        if (id in normalizedValues) {
          safeSetElementValue(id, normalizedValues[id]);
          return;
        }
        safeSetElementValue(id, previousState[id] ?? defaults[id] ?? '');
      });

      CHECK_BOXES.forEach((id) => {
        safeSetElementChecked(id, previousState[id] ?? false);
      });

      const autoExtractToggle = safeGetElementById(
        ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
      );
      const autoExtractOptions = safeGetElementById(
        ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
      );
      const hasAutoExtractChecked = CHECK_BOXES_AUTO_EXTRACT.some((id) =>
        safeGetElementChecked(id),
      );
      if (autoExtractToggle && autoExtractOptions) {
        autoExtractToggle.classList.toggle('active', hasAutoExtractChecked);
        autoExtractToggle.innerHTML = `<i class="codicon codicon-wand"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
        autoExtractOptions.style.display = 'none';
      }

      const toggleToolConfig = safeGetElementById(
        ELEMENT_IDS.TOGGLE_TOOL_CONFIG,
      );
      const toolConfigOptions = safeGetElementById(
        ELEMENT_IDS.TOOL_CONFIG_OPTIONS,
      );
      const hasToolConfigChecked = CHECK_BOXES_TOOL_USE.some((id) =>
        safeGetElementChecked(id),
      );
      if (toggleToolConfig && toolConfigOptions) {
        toggleToolConfig.classList.toggle('active', hasToolConfigChecked);
        toggleToolConfig.innerHTML = `<i class="codicon codicon-tools"></i><i class="${CHEVRON_DOWN_CLASS}"></i>`;
        toolConfigOptions.style.display = 'none';
      }

      MULTIPLE_SELECTIONS.forEach((id) => {
        const toggleId = `toggle${capitalize(id)}`;
        const selectDiv = safeGetElementById(id);
        if (!selectDiv) {
          console.warn(`Element with id '${id}' not found`);
          return;
        }
        selectDiv.innerHTML = '';

        const filesArray = previousState[id] ?? [];
        const isVisible = previousState[`${id}Visible`];

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
        const visible = previousState.latexdiffsVisible ?? false;
        latexdiffsContent.style.display = visible ? 'block' : 'none';
        setChevronIcon(toggleLatexdiffs, visible);
      }

      this.applySessionType(
        normalizedValues.sessionType ?? defaults.sessionType,
        { skipSave: true },
      );
    } else {
      this.setDefaults();
    }

    fileList.hideEmpty(MULTIPLE_SELECTIONS);
  }

  /** Persist current UI state */
  save() {
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

    const sessionTypeValue =
      state.sessionType ?? safeGetElementValue(SESSION_TYPE_INPUT);
    const normalizedSessionType =
      sessionTypeValue === SESSION_TYPES.TOOL_USE
        ? SESSION_TYPES.TOOL_USE
        : SESSION_TYPES.WORKFLOW;
    const activeSelectId = AGENT_SELECT_IDS[normalizedSessionType];
    if (activeSelectId) {
      state.agent = safeGetElementValue(activeSelectId) ?? '';
      state.isToolUseAgent = normalizedSessionType === SESSION_TYPES.TOOL_USE;
    }

    this.stateManager.setState(state);
  }

  applySessionType(sessionType, options = {}) {
    const { skipSave = false } = options;
    const normalized =
      sessionType === SESSION_TYPES.TOOL_USE
        ? SESSION_TYPES.TOOL_USE
        : SESSION_TYPES.WORKFLOW;
    const isToolUseSession = normalized === SESSION_TYPES.TOOL_USE;

    const sessionInput = safeGetElementById(SESSION_TYPE_INPUT);
    if (sessionInput) {
      sessionInput.value = normalized;
    }

    const toggleContainer = safeGetElementById(ELEMENT_IDS.SESSION_TYPE_TOGGLE);
    if (toggleContainer) {
      const radioGroup = toggleContainer.querySelector('vscode-radio-group');
      if (radioGroup) {
        const radios = radioGroup.querySelectorAll('vscode-radio');
        radios.forEach((radio) => {
          if (!(radio instanceof HTMLElement)) {
            return;
          }
          const radioValue =
            radio.dataset.sessionType || radio.getAttribute('value');
          const isActive = radioValue === normalized;
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
          const isActive = button.dataset.sessionType === normalized;
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
      const isActive = selectId === AGENT_SELECT_IDS[normalized];
      selectEl.classList.toggle('agent-select--active', isActive);
      selectEl.classList.toggle('agent-select--hidden', !isActive);
      selectEl.setAttribute('aria-hidden', isActive ? 'false' : 'true');
      selectEl.tabIndex = isActive ? 0 : -1;
    });

    setFileSelectionGroupDisabled(isToolUseSession);

    // Disable Tool Config dropdown for tool use sessions
    const toggleToolConfig = safeGetElementById(ELEMENT_IDS.TOGGLE_TOOL_CONFIG);
    if (toggleToolConfig instanceof HTMLElement) {
      toggleToolConfig.style.opacity = isToolUseSession ? '0.6' : '';
      toggleToolConfig.style.filter = isToolUseSession ? 'grayscale(0.3)' : '';
      toggleToolConfig.style.pointerEvents = isToolUseSession ? 'none' : '';
      toggleToolConfig.style.cursor = isToolUseSession ? 'not-allowed' : '';
    }

    if (!skipSave) {
      this.save();
    }
  }
}

export const mainViewState = new MainViewState();
fileList.setSaveFn(() => mainViewState.save());
