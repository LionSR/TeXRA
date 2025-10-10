// Local imports - webview
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES,
  ELEMENT_IDS,
  SESSION_TYPES,
  SESSION_TYPE_INPUT,
  AGENT_SELECT_IDS,
  AGENT_SELECT_LIST,
} from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { mainViewState } from '../mainViewState.js';
import { BaseUIManager } from './BaseUIManager.js';
import { webviewEventBus } from '../eventBus.js';
import { bannerManager } from './BannerManager.js';
import { safeGetElementById } from '@common/domUtils.js';
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands.js';
import { vscode } from '@common/webviewContext.js';

export class SettingsButtonManager extends BaseUIManager {
  constructor(
    vscodeInstance = vscode,
    toggleManager,
    latexdiffManager,
    state = mainViewState,
    eventBus = webviewEventBus,
  ) {
    super();
    this.vscode = vscodeInstance;
    this.toggleManager = toggleManager;
    this.latexdiffManager = latexdiffManager;
    this.state = state;
    this.eventBus = eventBus;
    this._dependencyInstallListeners = [];
  }

  _setupToggles() {
    this.addListener(ELEMENT_IDS.TOGGLE_AUTO_EXTRACT, 'click', (e) => {
      e.stopPropagation();
      const options = safeGetElementById(ELEMENT_IDS.AUTO_EXTRACT_OPTIONS);
      if (options) {
        const visible = options.style.display === 'block';
        options.style.display = visible ? 'none' : 'block';
      }
      this.toggleManager.updateAutoToggleState();
    });

    this.addListener(ELEMENT_IDS.TOGGLE_TOOL_CONFIG, 'click', (e) => {
      e.stopPropagation();
      const options = safeGetElementById(ELEMENT_IDS.TOOL_CONFIG_OPTIONS);
      if (options) {
        const visible = options.style.display === 'block';
        options.style.display = visible ? 'none' : 'block';
      }
      this.toggleManager.updateToolConfigToggleState();
    });

    CHECK_BOXES_AUTO_EXTRACT.forEach((id) => {
      this.addListener(id, 'change', () => {
        this.toggleManager.updateAutoToggleState();
      });
    });

    CHECK_BOXES_TOOL_USE.forEach((id) => {
      this.addListener(id, 'change', () => {
        this.toggleManager.updateToolConfigToggleState();
      });
    });

    CHECK_BOXES.forEach((id) => {
      this.addListener(id, 'change', handleCheckboxChange);
    });

    this.addListener(ELEMENT_IDS.TOGGLE_LATEXDIFFS, 'click', () => {
      this.latexdiffManager.toggleLatexdiffs();
    });
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

  _setupDropdowns() {
    const toggleContainer = safeGetElementById(ELEMENT_IDS.SESSION_TYPE_TOGGLE);
    if (toggleContainer) {
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
          this.state.applySessionType(sessionType);
          const selectId =
            AGENT_SELECT_IDS[sessionType] ??
            AGENT_SELECT_IDS[SESSION_TYPES.WORKFLOW];
          const selectElement = safeGetElementById(selectId);
          if (selectElement instanceof HTMLSelectElement) {
            this._handleAgentSelection(selectElement);
            selectElement.focus();
          } else {
            this.state.save();
          }
        });
      });
    }

    AGENT_SELECT_LIST.forEach((id) => {
      this.addListener(id, 'focus', (event) => {
        const target = event.target;
        if (
          !(target instanceof HTMLSelectElement) ||
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
        const target = event.target;
        if (
          !(target instanceof HTMLSelectElement) ||
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

    this.addListener('model', 'change', (e) => {
      const selectElement = e.target;
      const selectedOption = selectElement.options[selectElement.selectedIndex];

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

  _handleAgentSelection(selectElement) {
    if (!(selectElement instanceof HTMLSelectElement)) {
      return;
    }

    const sessionType =
      selectElement.dataset.sessionType || SESSION_TYPES.WORKFLOW;
    this.state.applySessionType(sessionType, { skipSave: true });

    const selectedAgent = selectElement.value;
    const selectedOption = selectElement.options[selectElement.selectedIndex];

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
      sessionInput.value = sessionType;
    }

    this.state.save();
  }
}
