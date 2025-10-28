// Local imports - webview
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
  AGENT_SELECT_LIST,
  normalizeSessionType,
  resolveRadioGroup,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { mainViewState } from '../mainViewState.js';
import { BaseUIManager } from './BaseUIManager.js';
import { webviewEventBus } from '../eventBus.js';
import { bannerManager } from './BannerManager.js';
import {
  safeGetElementById,
  safeGetElementChecked,
  isSelectLikeElement,
  getSelectedOptionElement,
} from '@common/domUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class SettingsButtonManager extends BaseUIManager {
  constructor(
    vscodeInstance = vscode,
    latexdiffManager,
    state = mainViewState,
    eventBus = webviewEventBus,
  ) {
    super();
    this.vscode = vscodeInstance;
    this.latexdiffManager = latexdiffManager;
    this.state = state;
    this.eventBus = eventBus;
    this._dependencyInstallListeners = [];
    this._lastRadioSessionType = undefined;
    this._menuObservers = [];
  }

  _setupToggles() {
    this._initializeMenuToggle({
      buttonId: ELEMENT_IDS.TOGGLE_AUTO_EXTRACT,
      menuId: ELEMENT_IDS.AUTO_EXTRACT_OPTIONS,
      checkboxIds: CHECK_BOXES_AUTO_EXTRACT,
    });

    this._initializeMenuToggle({
      buttonId: ELEMENT_IDS.TOGGLE_TOOL_CONFIG,
      menuId: ELEMENT_IDS.TOOL_CONFIG_OPTIONS,
      checkboxIds: CHECK_BOXES_TOOL_USE,
    });

    this.addListener(ELEMENT_IDS.TOGGLE_LATEXDIFFS, 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
  }

  _initializeMenuToggle({ buttonId, menuId, checkboxIds }) {
    const button = safeGetElementById(buttonId);
    const menu = safeGetElementById(menuId);

    if (!(button instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
      return;
    }

    this._ensureMenuUsesSlotContent(menu);

    // Requires @vscode-elements/elements v2.3.1+
    button.toggleable = true;
    button.setAttribute('aria-haspopup', 'true');

    const updateButtonState = () => {
      const hasChecked = checkboxIds.some((id) => safeGetElementChecked(id));
      button.checked = hasChecked;
    };

    const updateAriaExpanded = () => {
      const expanded = Boolean(menu.show);
      button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    };

    const handleButtonChange = (event) => {
      event.stopPropagation();
      menu.show = !menu.show;
    };

    this.addListener(button, 'change', handleButtonChange);

    const handleCheckboxUpdate = (event) => {
      handleCheckboxChange(event);
      updateButtonState();
    };

    checkboxIds.forEach((checkboxId) => {
      this.addListener(checkboxId, 'change', handleCheckboxUpdate);
    });

    // Observe the "show" attribute so we react when the menu closes itself
    // (e.g. due to focus loss or another menu opening).
    const observer = new MutationObserver(updateAriaExpanded);
    observer.observe(menu, { attributes: true, attributeFilter: ['show'] });
    this._menuObservers.push(observer);

    updateButtonState();
    updateAriaExpanded();
  }

  _ensureMenuUsesSlotContent(menu) {
    if (!menu || typeof menu.tagName !== 'string') {
      return;
    }

    if (menu.tagName.toLowerCase() !== 'vscode-context-menu') {
      return;
    }

    if (!('data' in menu)) {
      return;
    }

    const currentData = menu.data;
    if (!Array.isArray(currentData)) {
      return;
    }

    if (currentData.length > 0) {
      return;
    }

    try {
      // Attempt to clear the auto-provided data array so the component renders
      // its slotted children instead of expecting a data-driven configuration.
      menu.data = undefined;
      if (typeof menu.requestUpdate === 'function') {
        menu.requestUpdate();
      }
      return;
    } catch (error) {
      if (!(error instanceof TypeError)) {
        throw error;
      }
    }

    if ('_data' in menu) {
      menu._data = undefined;
    }

    if (typeof menu.requestUpdate === 'function') {
      menu.requestUpdate();
    }
  }

  _setupSettingsButtons() {
    this.addListener(ELEMENT_IDS.AGENT_SETTINGS_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_AGENT_SETTINGS,
      });
    });

    this.addListener(ELEMENT_IDS.MODEL_SETTINGS_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_MODEL_SETTINGS,
      });
    });
  }

  _setupDependencyBanner() {
    this.addListener(ELEMENT_IDS.DEPENDENCY_DISMISS_BUTTON, 'click', () => {
      // Hide the banner
      const element = safeGetElementById(ELEMENT_IDS.DEPENDENCY_BANNER);
      if (element) {
        element.style.setProperty('display', 'none');
      }
      // Update the setting to disable future reminders
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.UPDATE_DEPENDENCY_REMINDER_SETTING,
        value: false,
      });
    });

    this.addListener(ELEMENT_IDS.DEPENDENCY_RECHECK_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.RECHECK_DEPENDENCIES,
      });
    });

    this.eventBus.addEventListener('showDependencyBanner', (e) => {
      this._disposeDependencyInstallListeners();
      const missing = e.detail?.missingTools || [];
      bannerManager.showBanner(ELEMENT_IDS.DEPENDENCY_BANNER, {
        missingTools: missing,
      });

      const element = safeGetElementById(ELEMENT_IDS.DEPENDENCY_BANNER);
      if (element) {
        const buttons = element.querySelectorAll('.dependency-install-button');
        buttons.forEach((button) => {
          const tool = button.dataset.tool;
          const handleInstallClick = () => {
            this.vscode.postMessage({
              command: MAIN_VIEW_COMMANDS.OPEN_INSTALL_GUIDE,
              tool,
            });
          };
          this.addListener(button, 'click', handleInstallClick);
          this._dependencyInstallListeners.push({
            element: button,
            handler: handleInstallClick,
          });
        });
        element.style.setProperty('display', 'flex');
      }
    });

    this.eventBus.addEventListener('hideDependencyBanner', () => {
      this._disposeDependencyInstallListeners();
      bannerManager.hideBanner(ELEMENT_IDS.DEPENDENCY_BANNER);
    });
  }

  _disposeDependencyInstallListeners() {
    this._dependencyInstallListeners.forEach(({ element, handler }) => {
      this.removeListener(element, 'click', handler);
    });
    this._dependencyInstallListeners = [];
  }

  _disconnectMenuObservers() {
    this._menuObservers.forEach((observer) => observer.disconnect());
    this._menuObservers = [];
  }

  _setupDropdowns() {
    const toggleContainer = safeGetElementById(ELEMENT_IDS.SESSION_TYPE_TOGGLE);
    if (toggleContainer) {
      const handleSessionTypeSelection = (sessionType) => {
        const normalized = normalizeSessionType(sessionType);
        this._setLastRadioSessionType(normalized);
        this.state.applySessionType(normalized);
        const selectId =
          AGENT_SELECT_IDS[normalized] ??
          AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW];
        const selectElement = safeGetElementById(selectId);
        if (isSelectLikeElement(selectElement)) {
          this._handleAgentSelection(selectElement);
          if (typeof selectElement.focus === 'function') {
            selectElement.focus();
          }
        } else {
          this.state.save();
        }
      };

      /**
       * Gets the current session type from a vscode-radio-group element.
       * @param {HTMLElement} group - The radio group element
       * @returns {string|undefined} The session type, or undefined if not found
       */
      const getSessionTypeFromGroup = (group) => {
        if (
          !(group instanceof HTMLElement) ||
          typeof group.value !== 'string' ||
          group.value.length === 0
        ) {
          return undefined;
        }
        return group.value;
      };

      const radioGroup = resolveRadioGroup(toggleContainer);
      if (radioGroup) {
        // Initialize last session type from radio group
        // Only set if we can determine a valid initial value to avoid masking the first user interaction
        const initialSessionType = getSessionTypeFromGroup(radioGroup);
        if (initialSessionType) {
          this._setLastRadioSessionType(
            normalizeSessionType(initialSessionType),
          );
        }

        this.addListener(radioGroup, 'change', () => {
          const sessionType = getSessionTypeFromGroup(radioGroup);
          if (!sessionType) {
            return;
          }
          const normalized = normalizeSessionType(sessionType);
          if (normalized === this._lastRadioSessionType) {
            return;
          }
          handleSessionTypeSelection(normalized);
        });
      } else {
        const buttons = toggleContainer.querySelectorAll('[data-session-type]');
        buttons.forEach((button) => {
          this.addListener(button, 'click', () => {
            if (!(button instanceof HTMLElement)) {
              return;
            }
            const sessionType = button.dataset.sessionType;
            if (!sessionType) {
              return;
            }
            buttons.forEach((btn) => btn.classList.remove('active'));
            button.classList.add('active');
            handleSessionTypeSelection(sessionType);
          });
        });
      }
    }

    AGENT_SELECT_LIST.forEach((id) => {
      this.addListener(id, 'focus', (event) => {
        const target = event.currentTarget;
        if (
          !(target instanceof HTMLElement) ||
          !isSelectLikeElement(target) ||
          target.classList.contains('agent-select--hidden')
        ) {
          return;
        }
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION,
          key: 'agentPicker',
          text: 'Select which agent will handle your request.',
        });
      });

      this.addListener(id, 'change', (event) => {
        const target = event.currentTarget;
        if (
          !(target instanceof HTMLElement) ||
          !isSelectLikeElement(target) ||
          target.classList.contains('agent-select--hidden')
        ) {
          return;
        }
        this._handleAgentSelection(target);
      });
    });

    // Show instruction on focus, before user makes selection
    this.addListener('model', 'focus', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION,
        key: 'modelPicker',
        text: 'Choose the AI model used by the selected agent.',
      });
    });

    this.addListener('model', 'change', (event) => {
      const selectElement = event.currentTarget;
      if (
        !(selectElement instanceof HTMLElement) ||
        !isSelectLikeElement(selectElement)
      ) {
        return;
      }
      const selectedOption = getSelectedOptionElement(selectElement);

      // Always notify about model selection
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.MODEL_SELECTED,
        model: selectElement.value,
      });
      this.state.save();

      // Check if the selected option requires an API key (using data attribute)
      // Show banner to guide API key setup if needed
      if (selectedOption?.dataset?.requiresKey === 'true') {
        // Get provider from the option
        const provider = selectedOption?.dataset?.provider || 'Unknown';

        // Show banner with provider info - user can click banner button to access setup
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.SHOW_API_KEY_BANNER,
          provider,
        });
      } else {
        // Hide banner for models that don't require API keys
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.HIDE_API_KEY_BANNER,
        });
      }
    });
  }

  setup() {
    this._setupToggles();
    this._setupSettingsButtons();
    this._setupDropdowns();
    this._setupDependencyBanner();
  }

  cleanup() {
    this._disposeDependencyInstallListeners();
    this._disconnectMenuObservers();
    super.cleanup();
  }

  _handleAgentSelection(selectElement) {
    if (!isSelectLikeElement(selectElement)) {
      return;
    }

    const sessionType =
      selectElement.dataset.sessionType || SESSION_TYPES.WORKFLOW;
    const normalized = normalizeSessionType(sessionType);
    this._setLastRadioSessionType(normalized);
    this.state.applySessionType(normalized, { skipSave: true });

    const selectedAgent = selectElement.value;
    const selectedOption = getSelectedOptionElement(selectElement);

    if (
      selectedOption &&
      !selectedOption.classList.contains('disabled-option')
    ) {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER,
      });
    }

    this.vscode.postMessage({
      command: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
    });

    if (selectedAgent) {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: selectedAgent,
      });
    }

    const sessionInput = safeGetElementById(SESSION_TYPE_INPUT);
    if (sessionInput) {
      sessionInput.value = normalized;
    }

    this.state.save();
  }

  _setLastRadioSessionType(sessionType) {
    this._lastRadioSessionType = sessionType;
  }
}
