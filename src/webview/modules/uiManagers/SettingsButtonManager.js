// Local imports - webview
import {
  CHECK_BOXES_AUTO_EXTRACT,
  CHECK_BOXES_TOOL_USE,
  CHECK_BOXES,
} from '../constants.js';
import { ELEMENT_IDS } from '../constants.js';
import { handleCheckboxChange } from '../fileHandlers.js';
import { mainViewState } from '../mainViewState.js';
import { BaseUIManager } from './BaseUIManager.js';
import { webviewEventBus } from '../eventBus.js';
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
    this.addListener(ELEMENT_IDS.DEPENDENCY_DOCS_BUTTON, 'click', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.OPEN_INSTALLATION_DOCS,
      });
    });

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

    this.eventBus.addEventListener('showDependencyBanner', (e) => {
      const missing = e.detail?.missingTools || [];
      const element = safeGetElementById(ELEMENT_IDS.DEPENDENCY_BANNER);
      if (element) {
        const textSpan = element.querySelector('span');
        if (textSpan) {
          textSpan.textContent = `Missing dependencies: ${missing.join(', ')}`;
        }
        element.style.setProperty('display', 'flex');
      }
    });

    this.eventBus.addEventListener('hideDependencyBanner', () => {
      const element = safeGetElementById(ELEMENT_IDS.DEPENDENCY_BANNER);
      if (element) {
        element.style.setProperty('display', 'none');
      }
    });
  }

  _setupDropdowns() {
    // Show instruction on focus, before user makes selection
    this.addListener('agent', 'focus', () => {
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.SHOW_INSTRUCTION,
        key: 'agentPicker',
        text: 'Select which agent will handle your request.',
      });
    });

    this.addListener('agent', 'change', (e) => {
      const selectedAgent = e.target.value;
      const selectedOption = e.target.options[e.target.selectedIndex];

      // Hide agent config banner if a valid (non-disabled) agent is selected
      if (
        selectedOption &&
        !selectedOption.classList.contains('disabled-option')
      ) {
        this.vscode.postMessage({
          command: MAIN_VIEW_COMMANDS.HIDE_AGENT_CONFIG_BANNER,
        });
      }

      const reflectCheckbox = safeGetElementById('reflect');
      if (reflectCheckbox) {
        reflectCheckbox.checked = !selectedAgent.startsWith('correct');
      }
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE,
      });
      this.vscode.postMessage({
        command: MAIN_VIEW_COMMANDS.REQUEST_DEFAULT_OUTPUT_FILES,
        agent: selectedAgent,
      });
      this.state.save();
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
}
